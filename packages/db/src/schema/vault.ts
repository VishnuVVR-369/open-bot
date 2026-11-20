// The vault and purchases made with it.
import { type PurchaseStatus, type VaultKind } from "@open-bot/domain";
import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { approvals } from "./approvals";
import { chats } from "./chats";
import { createdAt, updatedAt } from "./columns";
import { runs } from "./runs";
import { teammates } from "./teammates";

/**
 * Logins and payment cards teammates fill in on the computer without reading them. The secret is
 * encrypted, and only the worker decrypts it, to type it on a teammate's screen.
 */
export const vaultItems = pgTable("vault_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").$type<VaultKind>().notNull(),
  name: text("name").notNull(),
  /** The site a login belongs to, like github.com. It only fills in there. */
  domain: text("domain"),
  /** What you see without the secret: the username, or "Visa •••• 4242". */
  hint: text("hint").notNull(),
  /** AES-256-GCM ciphertext of the fields, as JSON. */
  encrypted: text("encrypted").notNull(),
  /** The teammates that may use it, or null for every teammate. */
  teammateIds: uuid("bot_ids").array(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** What a teammate pays for with a vault card, which counts against its monthly budget. */
export const purchases = pgTable(
  "purchases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teammateId: uuid("bot_id")
      .notNull()
      .references(() => teammates.id, { onDelete: "cascade" }),
    cardId: uuid("card_id").references(() => vaultItems.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    chatId: uuid("chat_id").references(() => chats.id, { onDelete: "set null" }),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    amountCents: integer("amount_cents").notNull(),
    merchant: text("merchant").notNull(),
    description: text("description").notNull(),
    status: text("status").$type<PurchaseStatus>().notNull(),
    /** What the teammate said happened at checkout. */
    note: text("note"),
    /** Until when the teammate may fill the card for it. */
    fillableUntil: timestamp("fillable_until", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("purchases_bot_idx").on(table.teammateId, table.createdAt)],
);
