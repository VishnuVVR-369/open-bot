// Telegram's HTTP API client: one call, file downloads, and sending HTML split to fit its limit.
import type { Context } from "../../context";
import { splitTelegram, TELEGRAM_MAX_CHARS } from "@open-bot/domain";
import { WorkerError } from "../../core/errors";

export class TelegramError extends WorkerError {
  /** `code` is the Bot API's error code, or 0 when it didn't answer with one. */
  constructor(
    message: string,
    readonly code = 0,
  ) {
    super(400, message);
  }
}

/** The parts of Telegram's objects this feature reads. */
export interface TgUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: TgUser;
  text?: string;
  caption?: string;
  reply_to_message?: { message_id: number };
  photo?: { file_id: string; file_size?: number; width: number }[];
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: {
    id: string;
    from: TgUser;
    data?: string;
    message?: { message_id: number; chat: { id: number }; text?: string };
  };
}

export type InlineKeyboard = { text: string; callback_data?: string; url?: string }[][];
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** What the API client needs from the service: the worker's context and the token it calls with. */
export interface TelegramClient {
  readonly ctx: Context;
  readonly token: string | null;
}

export async function call<T>(
  service: TelegramClient,
  method: string,
  params: Record<string, unknown> = {},
  options: { token?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const token = options.token ?? service.token;
  if (!token) throw new TelegramError("Telegram isn't connected.");
  const base = service.ctx.env.TELEGRAM_API_BASE_URL.replace(/\/+$/, "");
  const signals = [AbortSignal.timeout(options.timeoutMs ?? 15_000)];
  if (options.signal) signals.push(options.signal);
  let response: Response;
  try {
    response = await fetch(`${base}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new TelegramError("Couldn't reach Telegram.");
  }
  const data = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: T;
    description?: string;
    error_code?: number;
  };
  if (!data.ok)
    throw new TelegramError(
      data.description ?? `Telegram answered ${response.status}`,
      data.error_code ?? response.status,
    );
  return data.result as T;
}

export async function download(service: TelegramClient, fileId: string): Promise<Buffer> {
  const file = await call<{ file_path?: string; file_size?: number }>(service, "getFile", {
    file_id: fileId,
  });
  if (!file.file_path) throw new TelegramError("Telegram didn't share that file.");
  const base = service.ctx.env.TELEGRAM_API_BASE_URL.replace(/\/+$/, "");
  const response = await fetch(`${base}/file/bot${service.token}/${file.file_path}`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new TelegramError("Couldn't download the file from Telegram.");
  return Buffer.from(await response.arrayBuffer());
}

/** Send HTML, split to fit; falls back to plain text if Telegram can't parse the HTML. */
export async function send(
  service: TelegramClient,
  chatId: string,
  html: string,
  options: { replyTo?: number; keyboard?: InlineKeyboard } = {},
): Promise<number[]> {
  const ids: number[] = [];
  const chunks = splitTelegram(html, TELEGRAM_MAX_CHARS);
  for (const [index, chunk] of chunks.entries()) {
    const last = index === chunks.length - 1;
    const params: Record<string, unknown> = {
      chat_id: chatId,
      text: chunk,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(index === 0 && options.replyTo
        ? { reply_parameters: { message_id: options.replyTo, allow_sending_without_reply: true } }
        : {}),
      ...(last && options.keyboard ? { reply_markup: { inline_keyboard: options.keyboard } } : {}),
    };
    let sent: { message_id: number };
    try {
      sent = await call<{ message_id: number }>(service, "sendMessage", params);
    } catch (error) {
      if (!(error instanceof TelegramError) || error.code !== 400) throw error;
      // Formatting Telegram couldn't parse, or a button it rejected: send it plain.
      const { parse_mode: _mode, reply_markup: markup, ...plain } = params;
      const keyboard = markup as { inline_keyboard: InlineKeyboard } | undefined;
      const safeKeyboard = keyboard?.inline_keyboard
        .map((row) => row.filter((button) => button.callback_data))
        .filter((row) => row.length);
      sent = await call<{ message_id: number }>(service, "sendMessage", {
        ...plain,
        text: chunk
          .replace(/<[^>]+>/g, "")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&"),
        ...(safeKeyboard?.length ? { reply_markup: { inline_keyboard: safeKeyboard } } : {}),
      });
    }
    ids.push(sent.message_id);
  }
  return ids;
}
