import { createSign } from "node:crypto";
import { nativePushDevices } from "@open-bot/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Context, NotificationEvent } from "../context";
import { errorMessage } from "../logger";
import { plainText } from "./push";

/**
 * What a phone gets: always a data message, never a notification message, so the app renders it
 * itself (with actions) and can drop one that's stale. Every value is a string, as FCM requires.
 */
export interface NativePushData {
  type: "notification" | "dismiss" | "egress-needed" | "run-progress";
  kind?: string;
  title?: string;
  body?: string;
  /** Replaces, or with `dismiss` removes, an earlier notification with the same tag. */
  tag: string;
  /** Where tapping it goes, as a route in the app. */
  url?: string;
  botId?: string;
  chatId?: string;
  runId?: string;
  /** A page to open, for a teammate's reply that published one. */
  pageId?: string;
  approvalId?: string;
  /** "true" when approving needs your fingerprint, like for a purchase. */
  approvalNeedsBiometric?: "true" | "false";
  takeoverId?: string;
}

export interface NativePush {
  data: NativePushData;
  /**
   * `high` only for what always shows a notification right away (approvals, takeover requests)
   * or starts a foreground service: FCM deprioritizes apps whose urgent messages show nothing.
   */
  priority: "high" | "normal";
  /** Only the latest message with the same key is delivered, like progress updates. */
  collapseKey?: string;
}

const MAX_BODY = 180;

/** Notifications that need you now go out at high priority; the rest can wait a little. */
const URGENT_KINDS = new Set(["approval", "takeover_request"]);

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
  return { data, priority: URGENT_KINDS.has(event.kind) ? "high" : "normal" };
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
    this.ctx.events.on("notification", (event) => {
      void this.sendAll(nativeNotification(event)).catch((error: unknown) =>
        this.ctx.log.warn("native push failed", { error: errorMessage(error) }),
      );
    });
    this.ctx.events.on("approvalDecided", (approvalId) => {
      void this.sendAll(nativeDismiss(approvalId)).catch((error: unknown) =>
        this.ctx.log.warn("native dismiss failed", { error: errorMessage(error) }),
      );
    });
    this.ctx.events.on("takeoverEnded", (id) => {
      void this.sendAll(nativeDismiss(id)).catch(() =>
        this.ctx.log.warn("native takeover dismiss deferred"),
      );
    });
  }

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

  /** Sends to every phone; tokens FCM says are gone are forgotten. */
  async sendAll(push: NativePush): Promise<number> {
    if (!this.account) return 0;
    const rows = await this.ctx.db.select().from(nativePushDevices);
    if (rows.length === 0) return 0;
    const accessToken = await this.accessToken();
    let sent = 0;
    await Promise.all(
      rows.map(async (row) => {
        try {
          const result = await this.send(accessToken, row.token, push);
          if (result === "gone") {
            await this.unregister(row.token);
            return;
          }
          sent += 1;
          await this.ctx.db
            .update(nativePushDevices)
            .set({ lastSentAt: new Date() })
            .where(eq(nativePushDevices.token, row.token));
        } catch (error) {
          this.ctx.log.warn("push to a phone failed", { error: errorMessage(error) });
        }
      }),
    );
    return sent;
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
              ttl: "3600s",
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
