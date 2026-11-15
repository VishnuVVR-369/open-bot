// Long polling Telegram for updates, one loop per (re)start, with backoff on failures. An update
// is acknowledged (the saved offset moves past it) only once it was handled: one that fails is
// fetched again and retried, and Telegram keeps it until then.
import { telegram } from "@open-bot/db";
import { eq } from "drizzle-orm";
import { publishApp } from "../../context";
import { errorMessage } from "../../logger";
import { createNotification } from "../notifications";
import { call, TelegramError, type TgUpdate } from "./api";
import { handle, type TelegramInbox } from "./inbound";

const POLL_SECONDS = 25;

/**
 * How long an update that keeps failing holds up the ones after it before it's skipped: at least
 * this many attempts and this long since its first failure. A deploy that changes the database
 * makes every update fail for a few minutes, so this is well beyond that. Retries back off with
 * `delayMs`.
 */
export interface UpdateRetry {
  attempts: number;
  ms: number;
  delayMs(failures: number): number;
}

export const UPDATE_RETRY: UpdateRetry = {
  attempts: 10,
  ms: 30 * 60_000,
  delayMs: (failures) => Math.min(60_000, 2_000 * 2 ** failures),
};

/** What the poll loop needs from the service, including the state it shares with `stop()`. */
export interface TelegramPoller extends TelegramInbox {
  running: boolean;
  abort: AbortController | null;
  problem: string | null;
  readonly generation: number;
  readonly retry: UpdateRetry;
  stop(): void;
}

/** The update that keeps failing, and since when. */
interface Failing {
  updateId: number;
  attempts: number;
  since: number;
}

export function listen(service: TelegramPoller) {
  service.stop();
  service.running = true;
  const generation = service.generation;
  void loop(service, generation);
}

export async function loop(service: TelegramPoller, generation: number) {
  let failures = 0;
  let failing: Failing | null = null;
  const current = () => service.running && generation === service.generation;
  while (current() && service.token) {
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
      let stuck: string | null = null;
      for (const update of updates) {
        if (!current()) return;
        try {
          await handle(service, update);
        } catch (error) {
          failing = failedAgain(failing, update.update_id);
          const { attempts, ms } = service.retry;
          if (failing.attempts < attempts || Date.now() - failing.since < ms) {
            // Not acknowledged: the next getUpdates returns it again, after a pause.
            service.ctx.log.warn("a Telegram update failed; trying it again", {
              updateId: update.update_id,
              attempt: failing.attempts,
              error: errorMessage(error),
            });
            stuck = errorMessage(error);
            break;
          }
          await skip(service, update, failing, error);
        }
        await service.ctx.db
          .update(telegram)
          .set({ updateOffset: update.update_id + 1 })
          .where(eq(telegram.id, 1));
        failing = null;
      }
      failures = stuck ? failures + 1 : 0;
      const problem = stuck
        ? `A message from Telegram couldn't be handled yet, so open-bot keeps trying: ${stuck}`
        : null;
      if (problem !== service.problem) {
        service.problem = problem;
        await publishApp(service.ctx, { type: "telegram" });
      }
      if (stuck) await pause(service.retry.delayMs(failures));
    } catch (error) {
      if (!current()) return;
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
        await publishApp(service.ctx, { type: "telegram" }).catch(() => {});
      }
      if (unauthorized) {
        service.running = false;
        return;
      }
      await pause(service.retry.delayMs(failures));
    }
  }
}

/** Count another failure of this update; a different update starts counting afresh. */
function failedAgain(failing: Failing | null, updateId: number): Failing {
  return failing?.updateId === updateId
    ? { ...failing, attempts: failing.attempts + 1 }
    : { updateId, attempts: 1, since: Date.now() };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Give up on an update that kept failing, so the ones after it get through, and tell you which
 * message it was. Telling you is best effort: the database may be what keeps failing.
 */
async function skip(service: TelegramPoller, update: TgUpdate, failing: Failing, error: unknown) {
  const minutes = Math.round((Date.now() - failing.since) / 60_000);
  service.ctx.log.error("skipped a Telegram update that kept failing", {
    updateId: update.update_id,
    attempts: failing.attempts,
    error: errorMessage(error),
  });
  try {
    const what = await describe(service, update);
    await createNotification(service.ctx, {
      kind: "telegram_skipped",
      title: "A Telegram message was skipped",
      body: `${what} kept failing for ${minutes} minute${minutes === 1 ? "" : "s"} (${errorMessage(error)}), so open-bot gave up on it. Send it again if it still matters.`,
    });
  } catch (notifyError) {
    service.ctx.log.error("couldn't tell you about a skipped Telegram update", {
      updateId: update.update_id,
      error: errorMessage(notifyError),
    });
  }
}

/** The skipped update, in words. Only your own messages are quoted. */
async function describe(service: TelegramPoller, update: TgUpdate): Promise<string> {
  if (update.callback_query) return "Pressing a button on Telegram";
  const message = update.message;
  const text = (message?.text ?? message?.caption ?? "").trim();
  const yours = message && String(message.chat.id) === (await service.linkedChat());
  if (!yours || !text) return "A message on Telegram";
  return `Your Telegram message “${text.length > 120 ? `${text.slice(0, 120)}…` : text}”`;
}
