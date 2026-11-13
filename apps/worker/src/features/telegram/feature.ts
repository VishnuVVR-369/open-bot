import type { Feature } from "../../core/feature";
import { errorMessage, type Logger } from "../../logger";
import type { TelegramService } from "./service";

/** Telegram's background work: long polling Telegram for your messages and approval buttons. */
export function telegramFeature(
  telegram: Pick<TelegramService, "start" | "stop">,
  log: Pick<Logger, "error">,
): Feature {
  return {
    name: "telegram",
    async start(runtime) {
      // Connecting to Telegram can take a while, and the worker doesn't wait for it.
      void telegram
        .start()
        .catch((error: unknown) =>
          log.error("Telegram didn't start", { error: errorMessage(error) }),
        );
      runtime.add("telegram", () => telegram.stop());
    },
    signals: {},
  };
}
