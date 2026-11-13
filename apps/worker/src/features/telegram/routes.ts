import { os } from "../../core/rpc";
import type { TelegramService } from "./service";

const ok = { ok: true } as const;

/** Connecting Telegram and linking your chat, as the web app asks (`workerContract.telegram`). */
export function telegramRoutes(telegram: TelegramService) {
  return {
    status: os.telegram.status.handler(() => telegram.status()),
    connect: os.telegram.connect.handler(({ input }) => telegram.connect(input.token)),
    linkCode: os.telegram.linkCode.handler(() => telegram.linkCode()),
    sendTest: os.telegram.sendTest.handler(async () => {
      await telegram.sendTest();
      return ok;
    }),
    unlink: os.telegram.unlink.handler(async () => {
      await telegram.unlink();
      return ok;
    }),
    disconnect: os.telegram.disconnect.handler(async () => {
      await telegram.disconnect();
      return ok;
    }),
  };
}
