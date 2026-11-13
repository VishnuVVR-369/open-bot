import { createSign } from "node:crypto";
import { nativePushDevices } from "@open-bot/db";
import type { CarryingPhoneMode, EgressPushStage, NativePushData } from "@open-bot/domain";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Context, NotificationEvent } from "../../context";
import { errorMessage } from "../../logger";
import { plainText } from "./push";
import { forgetPushToken } from "../../egress/devices";

export interface NativePush {
  data: NativePushData;
  /**
   * `high` for messages that show a notification or start a foreground service. Android can
   * refuse to start the background JavaScript that displays a normal-priority data message.
   * FCM deprioritizes apps whose urgent messages show nothing.
   */
  priority: "high" | "normal";
  /** Only the latest message with the same key is delivered, like progress updates. */
  collapseKey?: string;
  /** How long FCM keeps trying to deliver it (default an hour). */
  ttlSeconds?: number;
}

/** How a send to one token went. `gone` tokens have been forgotten everywhere. */
export type PushResult = "sent" | "gone" | "failed";

/**
 * Ask a paired phone to carry the computer's traffic. A wake is silent and only useful for a
 * few seconds; an ask shows a notification, and stays useful for a while.
 */
export function nativeEgressPush(
  stage: EgressPushStage,
  sentAt: Date,
  phoneMode: CarryingPhoneMode,
): NativePush {
  return {
    data: {
      type: "egress-needed",
      stage,
      sentAt: sentAt.toISOString(),
      phoneMode,
      tag: "egress",
      ...(stage === "ask"
        ? {
            title: "Teammates need your phone's connection",
            body: "Tap to start browsing through this phone.",
          }
        : {}),
    },
    priority: "high",
    collapseKey: `egress-${stage}`,
    ttlSeconds: stage === "wake" ? 30 : 600,
  };
}

const MAX_BODY = 180;

/** The phone's in-app route for a notification. */
function nativeUrl(event: NotificationEvent): string {
  if (event.kind === "approval" && event.approvalId) return `/approvals/${event.approvalId}`;
  if (event.pageId) return `/pages/${event.pageId}`;
  if (event.chatId) return `/chats/${event.chatId}${event.runId ? `?run=${event.runId}` : ""}`;
  return "/";
}

export function nativeNotification(event: NotificationEvent): NativePush {
  const body = plainText(event.body);
  const data: NativePushData = {
    type: "notification",
    kind: event.kind,
    title: event.title,
    body: body.length > MAX_BODY ? `${body.slice(0, MAX_BODY - 1)}…` : body,
    tag: event.approvalId ?? event.takeoverId ?? event.runId ?? event.id,
    url: nativeUrl(event),
    ...(event.botId ? { botId: event.botId } : {}),
    ...(event.chatId ? { chatId: event.chatId } : {}),
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.approvalId
      ? {
          approvalId: event.approvalId,
          approvalNeedsBiometric: event.approvalKind === "purchase" ? "true" : "false",
        }
      : {}),
    ...(event.takeoverId ? { takeoverId: event.takeoverId } : {}),
    ...(event.pageId ? { pageId: event.pageId } : {}),
  };
  // Every visible notification needs Android to start the app's background display handler,
  // including automation results and replies. The channel still controls how it alerts you.
  return { data, priority: "high" };
}

/** Removes an approval's notification once it's decided anywhere. */
export function nativeDismiss(tag: string): NativePush {
  return { data: { type: "dismiss", tag }, priority: "normal" };
}

const serviceAccountSchema = z.object({
  project_id: z.string().min(1),
  client_email: z.string().min(1),
  private_key: z.string().min(1),
  token_uri: z.string().url().default("https://oauth2.googleapis.com/token"),
});
type ServiceAccount = z.infer<typeof serviceAccountSchema>;

/** FCM's error codes that mean the token will never work again. */
const GONE_CODES = new Set(["UNREGISTERED", "SENDER_ID_MISMATCH"]);

/**
 * Push notifications to the Android app through Firebase Cloud Messaging (HTTP v1), with a
 * Firebase service account from `FCM_SERVICE_ACCOUNT_JSON`. Without one, phones get nothing.
 */
export class FcmService {
  private readonly account: ServiceAccount | null;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly ctx: Context) {
    const raw = ctx.env.FCM_SERVICE_ACCOUNT_JSON;
    this.account = raw ? serviceAccountSchema.parse(JSON.parse(raw)) : null;
  }

  get configured(): boolean {
    return this.account !== null;
  }

  start() {
    if (!this.account) {
      this.ctx.log.info("FCM_SERVICE_ACCOUNT_JSON is not set; phones won't get notifications");
      return;
    }
    this.ctx.events.on("notification", this.onNotification);
    this.ctx.events.on("approvalDecided", this.onApprovalDecided);
    this.ctx.events.on("takeoverEnded", this.onTakeoverEnded);
  }

  stop() {
    this.ctx.events.off("notification", this.onNotification);
    this.ctx.events.off("approvalDecided", this.onApprovalDecided);
    this.ctx.events.off("takeoverEnded", this.onTakeoverEnded);
  }

  private readonly onNotification = (event: NotificationEvent) => {
    void this.sendAll(nativeNotification(event)).catch((error: unknown) =>
      this.ctx.log.warn("native push failed", { error: errorMessage(error) }),
    );
  };
  private readonly onApprovalDecided = (approvalId: string) => {
    void this.sendAll(nativeDismiss(approvalId)).catch((error: unknown) =>
      this.ctx.log.warn("native dismiss failed", { error: errorMessage(error) }),
    );
  };
  private readonly onTakeoverEnded = (id: string) => {
    void this.sendAll(nativeDismiss(id)).catch(() =>
      this.ctx.log.warn("native takeover dismiss deferred"),
    );
  };

  async register(input: { token: string; platform: "android"; device: string }): Promise<void> {
    await this.ctx.db
      .insert(nativePushDevices)
      .values({ token: input.token, platform: input.platform, device: input.device.slice(0, 80) })
      .onConflictDoUpdate({
        target: nativePushDevices.token,
        set: { platform: input.platform, device: input.device.slice(0, 80) },
      });
  }

  async unregister(token: string): Promise<void> {
    await this.ctx.db.delete(nativePushDevices).where(eq(nativePushDevices.token, token));
  }

  /** Sends to every phone signed in for notifications; returns how many got it. */
  async sendAll(push: NativePush): Promise<number> {
    if (!this.account) return 0;
    const rows = await this.ctx.db.select().from(nativePushDevices);
    const results = await this.sendToTokens(
      rows.map((row) => row.token),
      push,
    );
    return [...results.values()].filter((result) => result === "sent").length;
  }

  /**
   * Sends to these tokens only, with each one's result. A token FCM says is gone is forgotten
   * everywhere it's kept: as a notification device and as a paired phone's wake token.
   */
  async sendToTokens(tokens: string[], push: NativePush): Promise<Map<string, PushResult>> {
    const results = new Map<string, PushResult>();
    if (!this.account || tokens.length === 0) return results;
    const accessToken = await this.accessToken();
    await Promise.all(
      [...new Set(tokens)].map(async (token) => {
        try {
          const result = await this.send(accessToken, token, push);
          results.set(token, result);
          if (result === "gone") {
            await this.forget(token);
            return;
          }
          await this.ctx.db
            .update(nativePushDevices)
            .set({ lastSentAt: new Date() })
            .where(eq(nativePushDevices.token, token));
        } catch (error) {
          results.set(token, "failed");
          this.ctx.log.warn("push to a phone failed", { error: errorMessage(error) });
        }
      }),
    );
    return results;
  }

  private async forget(token: string): Promise<void> {
    await this.unregister(token);
    await forgetPushToken(this.ctx.db, token);
  }

  private async send(
    accessToken: string,
    token: string,
    push: NativePush,
  ): Promise<"sent" | "gone"> {
    const account = this.account!;
    const data = Object.fromEntries(
      Object.entries(push.data).filter((entry): entry is [string, string] => Boolean(entry[1])),
    );
    const response = await fetch(
      `${this.ctx.env.FCM_API_BASE_URL}/v1/projects/${account.project_id}/messages:send`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            token,
            data,
            android: {
              priority: push.priority === "high" ? "HIGH" : "NORMAL",
              ttl: `${push.ttlSeconds ?? 3600}s`,
              ...(push.collapseKey ? { collapse_key: push.collapseKey } : {}),
            },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (response.ok) return "sent";
    const body = (await response.json().catch(() => ({}))) as {
      error?: { status?: string; message?: string; details?: { errorCode?: string }[] };
    };
    const codes = (body.error?.details ?? []).map((detail) => detail.errorCode);
    if (codes.some((code) => code && GONE_CODES.has(code))) return "gone";
    if (response.status === 401) this.token = null;
    throw new Error(
      `FCM answered ${response.status}: ${body.error?.message ?? body.error?.status ?? "no details"}`,
    );
  }

  /** An OAuth access token for FCM, from the service account (a signed JWT, exchanged once an hour). */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const account = this.account!;
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: account.token_uri,
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(account.private_key);
    const response = await fetch(account.token_uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature.toString("base64url")}`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error_description?: string;
    };
    if (!response.ok || !body.access_token)
      throw new Error(
        `Google refused the FCM credentials: ${body.error_description ?? response.status}`,
      );
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
    return this.token.value;
  }
}
