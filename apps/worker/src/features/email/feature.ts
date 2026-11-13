import type { Feature } from "../../core/feature";
import { errorMessage, type Logger } from "../../logger";
import type { EmailService } from "./service";

/**
 * Email's background work: at startup, acting on emails decided while the worker was down and
 * marking any caught mid-send, then a sweep every 30 s for decisions nobody acted on.
 */
export function emailFeature(
  email: Pick<EmailService, "recover" | "sweep">,
  log: Pick<Logger, "warn">,
): Feature {
  return {
    name: "email",
    async start(runtime) {
      await email
        .recover()
        .catch((error: unknown) =>
          log.warn("email recovery failed", { error: errorMessage(error) }),
        );
      runtime.every(
        "email sweep",
        30_000,
        () =>
          void email
            .sweep()
            .catch((error: unknown) =>
              log.warn("email sweep failed", { error: errorMessage(error) }),
            ),
      );
    },
    signals: {},
  };
}
