import { credentials, pushSubscriptions } from "@open-bot/db";
import { decryptSecret, encryptSecret } from "@open-bot/shared/secrets";
import { eq } from "drizzle-orm";
import webpush from "web-push";
import type { Context, NotificationEvent } from "../context";
import { errorMessage } from "../logger";

/** What the service worker shows: a notification that opens the right place when tapped. */
export interface PushPayload {
  title: string;
  body: string;
  /** Where tapping it goes, within the app. */
  url: string;
  /** Replaces an earlier notification with the same tag. */
  tag: string;
}

/** Markdown, as the short plain text a phone shows. */
function plain(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function pushPayload(event: NotificationEvent): PushPayload {
  const body = plain(event.body);
  const url =
    event.kind === "approval"
      ? "/approvals"
      : event.chatId
        ? `/chats/${event.chatId}${event.runId ? `#run-${event.runId}` : ""}`
        : "/";
  return {
    title: event.title,
    body: body.length > 180 ? `${body.slice(0, 179)}…` : body,
    url,
    tag: event.approvalId ?? event.runId ?? event.id,
  };
}

/** A device the app sends push notifications to, as the browser describes it. */
export interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * Push notifications to installed apps and browsers, even when open-bot isn't open. The keys that
 * sign them are made once and kept encrypted.
 */
export class PushService {
  private keys: { publicKey: string; privateKey: string } | null = null;

  constructor(private readonly ctx: Context) {}

  start() {
    this.ctx.events.on("notification", (event) => {
      void this.sendAll(pushPayload(event)).catch((error: unknown) =>
        this.ctx.log.warn("push failed", { error: errorMessage(error) }),
      );
    });
  }

  private async vapid(): Promise<{ publicKey: string; privateKey: string }> {
    if (this.keys) return this.keys;
    const [row] = await this.ctx.db
      .select()
      .from(credentials)
      .where(eq(credentials.kind, "vapid_keys"));
    if (row) {
      this.keys = JSON.parse(decryptSecret(row.encrypted, this.ctx.env.ENCRYPTION_KEY)) as {
        publicKey: string;
        privateKey: string;
      };
      return this.keys;
    }
    const keys = webpush.generateVAPIDKeys();
    await this.ctx.db
      .insert(credentials)
      .values({
        kind: "vapid_keys",
        encrypted: encryptSecret(JSON.stringify(keys), this.ctx.env.ENCRYPTION_KEY),
        hint: `${keys.publicKey.slice(0, 8)}…`,
      })
      .onConflictDoNothing();
    // Another process may have made them first; use whichever was saved.
    this.keys = null;
    return this.vapid();
  }

  async publicKey(): Promise<string> {
    return (await this.vapid()).publicKey;
  }

  async subscribe(subscription: Subscription, device: string): Promise<void> {
    const endpoint = new URL(subscription.endpoint);
    if (endpoint.protocol !== "https:" && !this.ctx.env.WATCH_ALLOW_PRIVATE_URLS)
      throw new Error("Push services use https.");
    await this.ctx.db
      .insert(pushSubscriptions)
      .values({
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        device: device.slice(0, 80),
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
      });
  }

  async unsubscribe(endpoint: string): Promise<void> {
    await this.ctx.db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
  }

  async devices(): Promise<{ endpoint: string; device: string; createdAt: Date }[]> {
    return this.ctx.db
      .select({
        endpoint: pushSubscriptions.endpoint,
        device: pushSubscriptions.device,
        createdAt: pushSubscriptions.createdAt,
      })
      .from(pushSubscriptions);
  }

  /** Sends to every device; ones the push service says are gone are forgotten. */
  async sendAll(payload: PushPayload): Promise<number> {
    const rows = await this.ctx.db.select().from(pushSubscriptions);
    if (rows.length === 0) return 0;
    const { publicKey, privateKey } = await this.vapid();
    const subject = this.ctx.env.APP_URL.startsWith("https://")
      ? this.ctx.env.APP_URL
      : "mailto:open-bot@localhost";
    let sent = 0;
    await Promise.all(
      rows.map(async (row) => {
        try {
          // web-push encrypts and signs; sending ourselves works with any push service URL.
          const request = webpush.generateRequestDetails(
            { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
            JSON.stringify(payload),
            { vapidDetails: { subject, publicKey, privateKey }, TTL: 60 * 60, urgency: "high" },
          );
          const response = await fetch(request.endpoint, {
            method: request.method,
            headers: request.headers as Record<string, string>,
            body: request.body ? new Uint8Array(request.body) : null,
            signal: AbortSignal.timeout(10_000),
          });
          if (response.status === 404 || response.status === 410) {
            await this.unsubscribe(row.endpoint);
            return;
          }
          if (!response.ok) throw new Error(`The push service answered ${response.status}`);
          sent += 1;
          await this.ctx.db
            .update(pushSubscriptions)
            .set({ lastSentAt: new Date() })
            .where(eq(pushSubscriptions.endpoint, row.endpoint));
        } catch (error) {
          this.ctx.log.warn("push to a device failed", { error: errorMessage(error) });
        }
      }),
    );
    return sent;
  }
}
