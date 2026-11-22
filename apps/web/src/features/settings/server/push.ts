import "server-only";
import type { ApiInputs } from "@open-bot/api";
import { worker } from "@/lib/server/worker";

type Inputs = ApiInputs["push"];

/**
 * Registers the phone's token for the session that sent it, so the phone gets nothing once that
 * session has ended, and says which registration was stored.
 */
export async function registerPushDevice(input: Inputs["registerDevice"], sessionId: string) {
  const stored = await worker.push.registerNative({ ...input, sessionId });
  return {
    ok: true as const,
    ...(stored.registration ? { registration: stored.registration } : {}),
  };
}

export async function unregisterPushDevice(input: Inputs["unregisterDevice"]) {
  await worker.push.unregisterNative(input);
  return { ok: true as const };
}

export async function sendTestPush() {
  return worker.push.test();
}
