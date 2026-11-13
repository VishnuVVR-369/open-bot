import "server-only";
import { os } from "@/lib/server/api/rpc";
import { worker } from "@/lib/server/worker";
import { registerPushDevice, sendTestPush, unregisterPushDevice } from "./push";
import {
  getModelAccess,
  getMonthlyUsage,
  removeApiKey,
  saveApiKey,
  setMonthlyCap,
  setTimezone,
} from "./service";

/**
 * Your settings, ChatGPT sign-in, Telegram and notifications, as the browser and the phone ask
 * (`contract.settings`, `contract.chatgpt`, `contract.telegram` and `contract.push`).
 */
export function settingsRoutes() {
  return {
    telegram: {
      status: os.telegram.status.handler(() => worker.telegram.status()),
      connect: os.telegram.connect.handler(({ input }) => worker.telegram.connect(input)),
      linkCode: os.telegram.linkCode.handler(() => worker.telegram.linkCode()),
      sendTest: os.telegram.sendTest.handler(() => worker.telegram.sendTest()),
      unlink: os.telegram.unlink.handler(() => worker.telegram.unlink()),
      disconnect: os.telegram.disconnect.handler(() => worker.telegram.disconnect()),
    },
    chatgpt: {
      setAuthSource: os.chatgpt.setAuthSource.handler(({ input }) =>
        worker.codex.setAuthSource(input),
      ),
      startLogin: os.chatgpt.startLogin.handler(() => worker.codex.deviceLogin()),
      signOut: os.chatgpt.signOut.handler(() => worker.codex.logout()),
    },
    settings: {
      modelAccess: os.settings.modelAccess.handler(() => getModelAccess()),
      usage: os.settings.usage.handler(() => getMonthlyUsage()),
      rateLimits: os.settings.rateLimits.handler(
        async () => (await worker.codex.rateLimits()).rateLimits,
      ),
      setTimezone: os.settings.setTimezone.handler(({ input }) => setTimezone(input)),
      saveApiKey: os.settings.saveApiKey.handler(({ input }) => saveApiKey(input)),
      removeApiKey: os.settings.removeApiKey.handler(() => removeApiKey()),
      setMonthlyCap: os.settings.setMonthlyCap.handler(({ input }) => setMonthlyCap(input)),
    },
    push: {
      status: os.push.status.handler(() => worker.push.status()),
      registerDevice: os.push.registerDevice.handler(({ input }) => registerPushDevice(input)),
      unregisterDevice: os.push.unregisterDevice.handler(({ input }) =>
        unregisterPushDevice(input),
      ),
      test: os.push.test.handler(() => sendTestPush()),
      subscribe: os.push.subscribe.handler(({ input }) => worker.push.subscribe(input)),
      unsubscribe: os.push.unsubscribe.handler(({ input }) => worker.push.unsubscribe(input)),
    },
  };
}
