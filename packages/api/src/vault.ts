import { z } from "zod";

/** A login or card in the vault, as the app shows it: never the secret itself. */
export const vaultItemViewSchema = z.object({
  id: z.string(),
  kind: z.enum(["login", "card"]),
  name: z.string(),
  /** The login's site, like github.com. */
  domain: z.string().nullable(),
  /** The username, or "Visa •••• 4242". */
  hint: z.string(),
  /** The teammates that may use it, or null for every teammate. */
  botIds: z.array(z.string()).nullable(),
  lastUsedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type VaultItemView = z.infer<typeof vaultItemViewSchema>;
