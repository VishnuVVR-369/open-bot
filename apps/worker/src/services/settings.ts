import { SETTINGS_ID, settings, type Queryable } from "@open-bot/db";
import { isValidTimeZone } from "@open-bot/domain";
import { publishApp, type Context } from "../context";
import { removeCredential, saveCredential } from "./credentials";
import { WorkerError } from "../core/errors";

/**
 * The owner's settings row. Only this module writes it, except the profile memory keeps
 * (packages/db/src/owners.ts); read it with `ownerSettings` from @open-bot/db.
 */

/** A settings change that can't be made as asked; the message says why. */
export class SettingsError extends WorkerError {
  constructor(message: string) {
    super(400, message);
  }
}

type Changes = Partial<
  Pick<
    typeof settings.$inferInsert,
    "timezone" | "monthlyCapMicros" | "chatgptAuthSource" | "planLimitedUntil"
  >
>;

/** Make the one settings row, if it isn't there yet. */
export async function addSettingsRow(db: Queryable): Promise<void> {
  await db.insert(settings).values({ id: SETTINGS_ID }).onConflictDoNothing();
}

/** Change these settings, making the row first if needed. */
export async function saveSettings(db: Queryable, changes: Changes): Promise<void> {
  await db
    .insert(settings)
    .values({ id: SETTINGS_ID, ...changes })
    .onConflictDoUpdate({ target: settings.id, set: changes });
}

/** The settings you change in Settings. */
export class SettingsService {
  constructor(private readonly ctx: Context) {}

  async setTimezone(timezone: string): Promise<void> {
    if (!isValidTimeZone(timezone)) throw new SettingsError("Unknown timezone.");
    await saveSettings(this.ctx.db, { timezone });
    await publishApp(this.ctx, { type: "settings" });
  }

  /** The most the API key may spend in a month. */
  async setMonthlyCap(dollars: number): Promise<void> {
    await saveSettings(this.ctx.db, { monthlyCapMicros: Math.round(dollars * 1_000_000) });
    await publishApp(this.ctx, { type: "auth" });
  }

  /** The OpenAI API key teammates continue on when the plan's limit is reached. */
  async saveApiKey(apiKey: string): Promise<void> {
    await saveCredential(this.ctx, "openai_api_key", apiKey);
    await publishApp(this.ctx, { type: "auth" });
  }

  async removeApiKey(): Promise<void> {
    await removeCredential(this.ctx.db, "openai_api_key");
    await publishApp(this.ctx, { type: "auth" });
  }
}
