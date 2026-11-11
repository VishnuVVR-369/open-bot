import "server-only";
import type { ApiInputs } from "@open-bot/api";
import { worker } from "../worker";

/** Your settings. The worker saves them (it owns them, see packages/db/src/owners.ts). */

type Inputs = ApiInputs["settings"];
type Ok = { ok: true };

export async function setTimezone({ timezone }: Inputs["setTimezone"]): Promise<Ok> {
  return worker.settings.setTimezone({ timezone });
}

/* ------------------------------------------------------------------ When the plan runs out */

export async function saveApiKey({ apiKey }: Inputs["saveApiKey"]): Promise<Ok> {
  return worker.settings.saveApiKey({ apiKey });
}

export async function removeApiKey(): Promise<Ok> {
  return worker.settings.removeApiKey();
}

export async function setMonthlyCap({ dollars }: Inputs["setMonthlyCap"]): Promise<Ok> {
  return worker.settings.setMonthlyCap({ dollars });
}
