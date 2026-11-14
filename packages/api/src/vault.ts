import { vaultKindSchema } from "@open-bot/domain";
import { id, teammateAccessSchema } from "./base";
import { z } from "zod";

/** A login or card in the vault, as the app shows it: never the secret itself. */
export const vaultItemViewSchema = z.object({
  id: z.string(),
  kind: vaultKindSchema,
  name: z.string(),
  /** The login's site, like github.com. */
  domain: z.string().nullable(),
  /** The username, or "Visa •••• 4242". */
  hint: z.string(),
  /** The teammates that may use it, or null for every teammate. */
  teammateIds: z.array(z.string()).nullable(),
  lastUsedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type VaultItemView = z.infer<typeof vaultItemViewSchema>;

/** The fields a login or card secret has; each kind uses its own. */
export const VAULT_SECRET_FIELDS = [
  "username",
  "password",
  "number",
  "expiry",
  "cvc",
  "name",
  "zip",
] as const;

/** A login or card to save: a new one, or with `id`, a change to one. */
export const vaultItemInputSchema = z.object({
  id: id.nullable(),
  kind: vaultKindSchema,
  name: z.string().trim().min(1, "Give it a name.").max(80),
  /** The login's site, like github.com; ignored for a card. */
  domain: z.string().max(300),
  teammateIds: teammateAccessSchema,
  /** The secret's fields. Fields left empty when editing keep what's saved. */
  secret: z.partialRecord(z.enum(VAULT_SECRET_FIELDS), z.string().max(500)),
});
export type VaultItemInput = z.infer<typeof vaultItemInputSchema>;
