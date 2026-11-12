// Devices that lend the computer their network (phone and desktop app egress).
import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createdAt } from "./columns";

/**
 * Phones paired to carry the computer's browser traffic. Each has its own secret (only its hash
 * is kept), separate from your session, so the phone's background service can only ever get
 * egress tokens. Pairing again bumps `generation`, which makes every older token useless.
 */
export const egressDevices = pgTable("egress_devices", {
  /** The phone's stable device id, made once per install. */
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  /** SHA-256 of the 256-bit device secret, in hex. */
  secretHash: text("secret_hash").notNull(),
  generation: integer("generation").notNull().default(1),
  /** The phone's current FCM token, for waking it. */
  pushToken: text("push_token"),
  createdAt: createdAt(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});
