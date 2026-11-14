// Long polling Telegram for updates, one loop per (re)start, with backoff on failures.
import { telegram } from "@open-bot/db";
import { eq } from "drizzle-orm";
import { publishApp } from "../../context";
import { errorMessage } from "../../logger";
import { call, TelegramError, type TgUpdate } from "./api";
import { handle, type TelegramInbox } from "./inbound";

const POLL_SECONDS = 25;

/** What the poll loop needs from the service, including the state it shares with `stop()`. */
export interface TelegramPoller extends TelegramInbox {
  running: boolean;
  abort: AbortController | null;
  problem: string | null;
  readonly generation: number;
  stop(): void;
}

export function listen(service: TelegramPoller) {
  service.stop();
  service.running = true;
  const generation = service.generation;
  void loop(service, generation);
}

export async function loop(service: TelegramPoller, generation: number) {
  let failures = 0;
  while (service.running && generation === service.generation && service.token) {
    service.abort = new AbortController();
    try {
      const [row] = await service.ctx.db
        .select({ offset: telegram.updateOffset })
        .from(telegram)
        .where(eq(telegram.id, 1));
      const updates = await call<TgUpdate[]>(
        service,
        "getUpdates",
        {
          offset: row?.offset ?? 0,
          timeout: POLL_SECONDS,
          allowed_updates: ["message", "callback_query"],
        },
        { timeoutMs: (POLL_SECONDS + 10) * 1000, signal: service.abort.signal },
      );
      if (generation !== service.generation) return;
      if (service.problem) {
        service.problem = null;
        await publishApp(service.ctx, { type: "telegram" });
      }
      failures = 0;
      for (const update of updates) {
        await handle(service, update).catch((error: unknown) =>
          service.ctx.log.error("a Telegram update failed", { error: errorMessage(error) }),
        );
        await service.ctx.db
          .update(telegram)
          .set({ updateOffset: update.update_id + 1 })
          .where(eq(telegram.id, 1));
      }
    } catch (error) {
      if (generation !== service.generation || !service.running) return;
      failures += 1;
      const unauthorized = error instanceof TelegramError && error.code === 401;
      const conflict = error instanceof TelegramError && error.code === 409;
      const problem = unauthorized
        ? "Telegram stopped accepting the bot token. Connect the bot again."
        : conflict
          ? "Another program is reading this bot's messages. Stop it, or make a new bot."
          : errorMessage(error);
      if (problem !== service.problem) {
        service.problem = problem;
        await publishApp(service.ctx, { type: "telegram" });
      }
      if (unauthorized) {
        service.running = false;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, 2_000 * 2 ** failures)));
    }
  }
}
