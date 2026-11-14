// Notifications to the linked Telegram chat: each kind formatted as HTML, and the sent messages
// remembered so a reply there continues the right chat.
import {
  approvals,
  bots,
  messages,
  pages,
  pageVersions,
  runs,
  telegramMessages,
} from "@open-bot/db";
import { telegramHtml } from "@open-bot/domain";
import { and, desc, eq, or } from "drizzle-orm";
import type { NotificationEvent } from "../../context";
import { escapeHtml, send, type TelegramClient } from "./api";

/** What sending notifications needs from the service. */
export interface TelegramNotifier extends TelegramClient {
  linkedChat(): Promise<string | null>;
}

export function appLink(service: TelegramClient, path: string): string {
  return `${service.ctx.env.APP_URL.replace(/\/+$/, "")}${path}`;
}

export async function onNotification(service: TelegramNotifier, event: NotificationEvent) {
  if (!service.token) return;
  const telegramChatId = await service.linkedChat();
  if (!telegramChatId) return;

  // Replies to what you sent from Telegram go back as replies there.
  if ((event.kind === "run_finished" || event.kind === "run_failed") && event.runId) {
    const origin = await telegramOrigin(service, event.runId);
    const [run] = await service.ctx.db.select().from(runs).where(eq(runs.id, event.runId));
    if (!run) return;
    const automation =
      run.trigger === "schedule" || run.trigger === "watch" || run.trigger === "webhook";
    // Runs you started in the app stay in the app.
    if (!origin && !automation && event.kind === "run_finished") return;
    const [bot] = await service.ctx.db
      .select({ name: bots.name })
      .from(bots)
      .where(eq(bots.id, run.botId));
    const name = escapeHtml(bot?.name ?? "Your teammate");
    const pageLinks = await publishedPageLinks(service, run.id);
    const body =
      event.kind === "run_failed"
        ? `⚠️ <b>${name} couldn't finish.</b>\n${escapeHtml(event.body)}`
        : `<b>${origin ? name : escapeHtml(event.title)}</b>\n${telegramHtml(run.finalText ?? "Done.")}${pageLinks}`;
    const ids = await send(service, telegramChatId, body, { replyTo: origin?.telegramMessageId });
    await remember(service, telegramChatId, ids, { chatId: run.chatId });
    return;
  }

  if (event.kind === "approval" && event.approvalId) {
    const [approval] = await service.ctx.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, event.approvalId));
    if (!approval || approval.status !== "pending") return;
    const detail = approval.detail.trim();
    const html = [
      `🛡 <b>${escapeHtml(event.title)}</b>`,
      escapeHtml(approval.title),
      detail ? `<blockquote expandable>${escapeHtml(detail.slice(0, 3000))}</blockquote>` : null,
    ]
      .filter(Boolean)
      .join("\n");
    const ids = await send(service, telegramChatId, html, {
      keyboard: [
        [
          { text: "Approve", callback_data: `ap:${approval.id}:y` },
          { text: "Deny", callback_data: `ap:${approval.id}:n` },
        ],
      ],
    });
    await remember(service, telegramChatId, ids, {
      chatId: approval.chatId,
      approvalId: approval.id,
    });
    return;
  }

  const icon =
    event.kind === "takeover_request"
      ? "🖐"
      : event.kind === "cap_reached"
        ? "💳"
        : event.kind === "egress_unanswered"
          ? "📱"
          : "💬";
  const link =
    event.kind === "takeover_request" && event.botId
      ? appLink(service, `/computer?screen=${event.botId}`)
      : event.chatId
        ? appLink(service, `/chats/${event.chatId}`)
        : null;
  const html = [
    `${icon} <b>${escapeHtml(event.title)}</b>`,
    event.body ? escapeHtml(event.body) : null,
    link
      ? `<a href="${link.replace(/"/g, "&quot;")}">${event.kind === "takeover_request" ? "Open the screen" : "Open in open-bot"}</a>`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
  const ids = await send(service, telegramChatId, html);
  if (event.chatId) await remember(service, telegramChatId, ids, { chatId: event.chatId });
}

/** Links to the pages a run published, to open in the app. */
export async function publishedPageLinks(service: TelegramClient, runId: string): Promise<string> {
  const rows = await service.ctx.db
    .selectDistinct({ id: pages.id, title: pages.title })
    .from(pageVersions)
    .innerJoin(pages, eq(pages.id, pageVersions.pageId))
    .where(eq(pageVersions.runId, runId));
  return rows
    .map(
      (page) =>
        `\n📄 <a href="${escapeHtml(appLink(service, `/pages/${page.id}`))}">${escapeHtml(page.title)}</a>`,
    )
    .join("");
}

/** The Telegram message that started or steered a run, if any. */
export async function telegramOrigin(service: TelegramClient, runId: string) {
  const [run] = await service.ctx.db
    .select({ messageId: runs.messageId })
    .from(runs)
    .where(eq(runs.id, runId));
  const [origin] = await service.ctx.db
    .select({ telegramMessageId: telegramMessages.telegramMessageId })
    .from(telegramMessages)
    .innerJoin(messages, eq(messages.id, telegramMessages.messageId))
    .where(
      and(
        eq(messages.via, "telegram"),
        or(
          run?.messageId ? eq(messages.id, run.messageId) : undefined,
          eq(messages.steeredRunId, runId),
        ),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return origin ?? null;
}

export async function remember(
  service: TelegramClient,
  telegramChatId: string,
  ids: number[],
  target: { chatId: string; approvalId?: string },
) {
  if (ids.length === 0) return;
  await service.ctx.db
    .insert(telegramMessages)
    .values(
      ids.map((id) => ({
        telegramChatId,
        telegramMessageId: id,
        chatId: target.chatId,
        approvalId: target.approvalId ?? null,
      })),
    )
    .onConflictDoNothing();
}
