// The connections as teammates see them, and the rules for giving a teammate access to one.
import { configurationRevision, connections, type Queryable } from "@open-bot/db";
import { asc, eq } from "drizzle-orm";
import { publishApp, type Context } from "../../context";
import { setConnectionTeammates } from "../connections";
import { TeammateError } from "./errors";

/** A connection as teammates see it: no credentials, with a revision for safe edits. */
export interface ConnectionSummary {
  id: string;
  label: string;
  enabled: boolean;
  /** Teammates that may use it, or null for every teammate. */
  teammateIds: string[] | null;
  revision: string;
}

export function connectionSummary(row: {
  id: string;
  label: string;
  enabled: boolean;
  teammateIds: string[] | null;
  updatedAt: Date;
}): ConnectionSummary {
  const { updatedAt, ...summary } = row;
  return { ...summary, revision: configurationRevision({ ...summary, updatedAt }) };
}

/**
 * Why giving or taking a teammate's access to a connection can't happen, or what it would
 * change. Checked before asking for approval and again inside the change.
 */
export function connectionAssignment(
  connection: ConnectionSummary,
  teammateId: string,
  assigned: boolean,
  expectedRevision: string,
): { teammateIds: string[] } | "unchanged" {
  if (connection.revision !== expectedRevision)
    throw new TeammateError(
      409,
      "That connection changed. List connections again before assigning it.",
    );
  if (assigned && !connection.enabled)
    throw new TeammateError(
      400,
      "This connection is turned off. The user can turn it on in Settings.",
    );
  if (connection.teammateIds === null) {
    if (assigned) return "unchanged";
    throw new TeammateError(
      400,
      "This connection is shared with every teammate. The user can limit it to some teammates in Settings.",
    );
  }
  const has = connection.teammateIds.includes(teammateId);
  if (has === assigned) return "unchanged";
  return {
    teammateIds: assigned
      ? [...connection.teammateIds, teammateId]
      : connection.teammateIds.filter((id) => id !== teammateId),
  };
}

export async function connectionSummaries(db: Queryable): Promise<ConnectionSummary[]> {
  const rows = await db
    .select({
      id: connections.id,
      label: connections.label,
      enabled: connections.enabled,
      teammateIds: connections.teammateIds,
      updatedAt: connections.updatedAt,
    })
    .from(connections)
    .orderBy(asc(connections.label));
  return rows.map((row) => connectionSummary(row));
}

export async function assignConnection(
  ctx: Context,
  teammateId: string,
  connectionId: string,
  assigned: boolean,
  expectedRevision: string,
) {
  const changed = await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: connections.id,
        label: connections.label,
        enabled: connections.enabled,
        teammateIds: connections.teammateIds,
        updatedAt: connections.updatedAt,
      })
      .from(connections)
      .where(eq(connections.id, connectionId))
      .for("update");
    if (!row) throw new TeammateError(404, "That connection no longer exists.");
    const change = connectionAssignment(
      connectionSummary(row),
      teammateId,
      assigned,
      expectedRevision,
    );
    if (change === "unchanged") return false;
    await setConnectionTeammates(tx, connectionId, change.teammateIds);
    return true;
  });
  if (changed) await publishApp(ctx, { type: "connections" });
  return { teammateId, connectionId, assigned, effectiveFrom: "the teammate's next run" };
}
