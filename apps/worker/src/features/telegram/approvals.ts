// Approval requests' buttons: pressing one decides the approval, and a decision made anywhere
// replaces the buttons with how it was decided.
import { approvals, telegramMessages } from "@open-bot/db";
import { eq } from "drizzle-orm";
import { errorMessage } from "../../logger";
import type { ApprovalService } from "../approvals";
import { call, TelegramError, type TelegramClient, type TgUpdate } from "./api";

/** Telegram's answers to an edit that has nothing to do: already made, or the message is gone. */
const EXPECTED_EDIT_REFUSAL = /message is not modified|message to edit not found/i;

/** What the approval buttons need from the service. */
export interface ApprovalButtons extends TelegramClient {
  readonly approvalService: ApprovalService;
  linkedChat(): Promise<string | null>;
}

export async function onButton(
  service: ApprovalButtons,
  query: NonNullable<TgUpdate["callback_query"]>,
) {
  const chatId = await service.linkedChat();
  // Telegram refuses answers to old button presses; the toast is only a courtesy.
  const answer = (text: string) =>
    call(service, "answerCallbackQuery", { callback_query_id: query.id, text }).catch(() => {});
  if (!chatId || String(query.from.id) !== chatId) {
    await answer("This isn't linked to your open-bot.");
    return;
  }
  const match = /^ap:([0-9a-f-]{36}):(y|n)$/.exec(query.data ?? "");
  if (!match) {
    await answer("That button doesn't do anything anymore.");
    return;
  }
  const decision = match[2] === "y" ? "approved" : "denied";
  const decided = await service.approvalService.decide(match[1]!, decision);
  const [row] = await service.ctx.db
    .select({ status: approvals.status })
    .from(approvals)
    .where(eq(approvals.id, match[1]!));
  await answer(decided ? (decision === "approved" ? "Approved" : "Denied") : "Already decided");
  if (query.message)
    await markDecided(
      service,
      String(query.message.chat.id),
      query.message.message_id,
      row?.status,
    );
}

/** Replace an approval's buttons with how it was decided. */
export async function markDecided(
  service: TelegramClient,
  chatId: string,
  messageId: number,
  status: string | undefined,
) {
  const label =
    status === "approved" ? "✅ Approved" : status === "denied" ? "🚫 Denied" : "⌛ Expired";
  await call(service, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [[{ text: label, callback_data: "noop" }]] },
  }).catch((error: unknown) => {
    // Both the button press and the decision event mark the message, so Telegram refuses the
    // second edit as "not modified"; a deleted message is refused as "not found".
    if (error instanceof TelegramError && EXPECTED_EDIT_REFUSAL.test(error.message)) return;
    service.ctx.log.warn("couldn't mark a Telegram approval decided", {
      error: errorMessage(error),
    });
  });
}

/** When an approval is decided anywhere, its Telegram buttons show the decision. */
export async function approvalDecided(service: TelegramClient, approvalId: string): Promise<void> {
  if (!service.token) return;
  const [approval] = await service.ctx.db
    .select({ status: approvals.status })
    .from(approvals)
    .where(eq(approvals.id, approvalId));
  const sent = await service.ctx.db
    .select()
    .from(telegramMessages)
    .where(eq(telegramMessages.approvalId, approvalId));
  for (const message of sent)
    await markDecided(service, message.telegramChatId, message.telegramMessageId, approval?.status);
}
