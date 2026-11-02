import "server-only";
import type { ApiInputs } from "@open-bot/api";
import { worker } from "../worker";

type Inputs = ApiInputs["push"];

export async function registerPushDevice(input: Inputs["registerDevice"]) {
  await worker("POST", "/internal/push/native/register", input);
  return { ok: true as const };
}

export async function unregisterPushDevice(input: Inputs["unregisterDevice"]) {
  await worker("POST", "/internal/push/native/unregister", input);
  return { ok: true as const };
}

export async function sendTestPush() {
  return worker<{ sent: number }>("POST", "/internal/push/test");
}
