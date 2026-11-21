// Whether an account action may still run, checked again each time it is about to.
import { accountConnections, connections, type Queryable } from "@open-bot/db";
import {
  accountTool,
  capabilityGranted,
  integration,
  isAccountConnectionKind,
} from "@open-bot/domain";
import type { ActionRow, ResolvedConnection } from "@open-bot/integrations/adapters";
import { eq } from "drizzle-orm";

/**
 * The connection and account the action runs with, if it still may. Looking one up (`strict`
 * false) only needs the same account, still signed in. Running it (`strict`) needs everything it
 * was approved under to still hold: the connection on and unchanged, the teammate still allowed,
 * the capability still allowed and granted, and the grant itself not narrowed or remade.
 */
export async function checkAction(
  db: Queryable,
  action: ActionRow,
  strict: boolean,
): Promise<{ resolved: ResolvedConnection } | { reason: string }> {
  if (!action.connectionId || !action.accountId)
    return { reason: "The user removed the connection." };
  const [row] = await db
    .select({ connection: connections, account: accountConnections })
    .from(connections)
    .innerJoin(accountConnections, eq(accountConnections.id, connections.accountId))
    .where(eq(connections.id, action.connectionId));
  if (!row || !isAccountConnectionKind(row.connection.kind))
    return { reason: "The user removed the connection." };
  const kind = row.connection.kind;
  const label = integration(kind).label;
  if (row.account.id !== action.accountId)
    return { reason: `${label} uses a different account now.` };
  if (row.account.status !== "connected") return { reason: `${label} needs reconnecting.` };
  if (strict) {
    if (!row.connection.enabled) return { reason: `The user turned ${label} off.` };
    if (row.connection.revision !== action.connectionRevision)
      return { reason: `The user changed ${label}'s settings since it was asked for.` };
    if (row.account.grantRevision !== action.grantRevision)
      return { reason: `${label}'s sign-in changed since it was asked for.` };
    if (
      row.connection.teammateIds &&
      (!action.teammateId || !row.connection.teammateIds.includes(action.teammateId))
    )
      return { reason: `The teammate no longer has ${label}.` };
    const capability = accountTool(action.tool)?.capability;
    if (
      !capability ||
      !row.connection.capabilities.includes(capability) ||
      !capabilityGranted(kind, capability, row.account.scopes)
    )
      return { reason: `${label} no longer allows this.` };
  }
  return { resolved: { kind, connection: row.connection, account: row.account } };
}
