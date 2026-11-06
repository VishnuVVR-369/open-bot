import { computers, egressDevices, type Db } from "@open-bot/db";
import { asc, eq, isNull } from "drizzle-orm";
import type { RelayStore } from "./relay";

/** The relay's state in Postgres: the modes on the computer's row, and the paired phones. */
export function databaseStore(db: Db): RelayStore {
  return {
    async loadModes() {
      const [row] = await db.select().from(computers).where(eq(computers.id, "default"));
      return { mode: row?.egressMode ?? "prefer", phoneMode: row?.phoneEgress ?? "fallback" };
    },
    async saveMode(mode) {
      await db
        .insert(computers)
        .values({ id: "default", egressMode: mode })
        .onConflictDoUpdate({ target: computers.id, set: { egressMode: mode } });
    },
    async savePhoneMode(mode) {
      await db
        .insert(computers)
        .values({ id: "default", phoneEgress: mode })
        .onConflictDoUpdate({ target: computers.id, set: { phoneEgress: mode } });
    },
    async pairedPhones() {
      const rows = await db
        .select()
        .from(egressDevices)
        .where(isNull(egressDevices.revokedAt))
        .orderBy(asc(egressDevices.createdAt));
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        generation: row.generation,
        pushToken: row.pushToken,
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      }));
    },
  };
}
