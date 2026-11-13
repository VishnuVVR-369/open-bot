import "server-only";
import type { ApiInputs } from "@open-bot/api";
import { worker } from "@/lib/server/worker";

type Inputs = ApiInputs["push"];

export async function registerPushDevice(input: Inputs["registerDevice"]) {
  await worker.push.registerNative(input);
  return { ok: true as const };
}

export async function unregisterPushDevice(input: Inputs["unregisterDevice"]) {
  await worker.push.unregisterNative(input);
  return { ok: true as const };
}

export async function sendTestPush() {
  return worker.push.test();
}
