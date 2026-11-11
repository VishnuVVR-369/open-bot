import "server-only";
import type { ApiInputs } from "@open-bot/api";
import { credentials, settings } from "@open-bot/db";
import { isValidTimeZone } from "@open-bot/domain";
import { encryptSecret, secretHint } from "@open-bot/domain/server";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { serverEnv } from "../env";
import { publish } from "../publish";
import { ApiError } from "./errors";

type Inputs = ApiInputs["settings"];
type Ok = { ok: true };

export async function setTimezone({ timezone }: Inputs["setTimezone"]): Promise<Ok> {
  if (!isValidTimeZone(timezone)) throw new ApiError("BAD_REQUEST", "Unknown timezone.");
  await db.update(settings).set({ timezone }).where(eq(settings.id, 1));
  return { ok: true };
}

/* ------------------------------------------------------------------ When the plan runs out */

export async function saveApiKey({ apiKey }: Inputs["saveApiKey"]): Promise<Ok> {
  const encrypted = encryptSecret(apiKey, serverEnv.encryptionKey);
  await db
    .insert(credentials)
    .values({ kind: "openai_api_key", encrypted, hint: secretHint(apiKey) })
    .onConflictDoUpdate({
      target: credentials.kind,
      set: { encrypted, hint: secretHint(apiKey) },
    });
  await publish({ type: "auth" });
  return { ok: true };
}

export async function removeApiKey(): Promise<Ok> {
  await db.delete(credentials).where(eq(credentials.kind, "openai_api_key"));
  await publish({ type: "auth" });
  return { ok: true };
}

export async function setMonthlyCap({ dollars }: Inputs["setMonthlyCap"]): Promise<Ok> {
  await db
    .update(settings)
    .set({ monthlyCapMicros: Math.round(dollars * 1_000_000) })
    .where(eq(settings.id, 1));
  await publish({ type: "auth" });
  return { ok: true };
}
