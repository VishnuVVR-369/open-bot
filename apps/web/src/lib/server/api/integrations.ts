import "server-only";
import type { ApiInputs, ApiOutputs } from "@open-bot/api";
import { bots as teammates } from "@open-bot/db";
import type { AccountCapability } from "@open-bot/domain";
import { isNull } from "drizzle-orm";
import { saveOwnerClient, startAuthorization } from "../accounts";
import { db } from "../db";
import { worker } from "../worker";
import { syncWorkspace } from "./teammates";

/** Connections, accounts and email: what teammates use outside the computer. */

type Inputs = ApiInputs;
type Ok = { ok: true };

/* ------------------------------------------------------------------ Email */

/**
 * Your teammates' email: the domain their addresses are on, and Postmark's server token, which
 * sends what they write. A token left empty keeps the saved one. The worker saves them.
 */
export async function saveEmailSettings(input: Inputs["email"]["save"]): Promise<Ok> {
  await worker.email.save(input);
  // Teammates learn their address in their instructions.
  const team = await db
    .select({ id: teammates.id })
    .from(teammates)
    .where(isNull(teammates.archivedAt));
  for (const teammate of team) await syncWorkspace(teammate.id);
  return { ok: true };
}

export async function removeEmailToken(): Promise<Ok> {
  return worker.email.removeToken();
}

/* ------------------------------------------------------------------ Connections */

/**
 * Connections are the worker's (it owns them, see packages/db/src/owners.ts): it saves an MCP
 * server with its secrets encrypted, and cancels what waits on an account connection that changes.
 */
export async function saveConnection(
  input: Inputs["connections"]["save"],
): Promise<{ id: string }> {
  return worker.connections.save(input);
}

export async function setConnectionEnabled(
  input: Inputs["connections"]["setEnabled"],
): Promise<Ok> {
  return worker.connections.setEnabled(input);
}

/**
 * Remove a connection. For an account, the last connection using it also revokes its access at
 * the provider; the warning says when that couldn't be done.
 */
export async function removeConnection({
  connectionId,
}: Inputs["connections"]["remove"]): Promise<ApiOutputs["connections"]["remove"]> {
  return worker.connections.remove({ connectionId });
}

/** Connect to the service from the computer, and list what it offers. */
export async function testConnection({
  connectionId,
}: Inputs["connections"]["test"]): Promise<ApiOutputs["connections"]["test"]> {
  return worker.connections.test({ connectionId }, { context: { timeoutMs: 90_000 } });
}

/* ------------------------------------------------------------------ Accounts */

/** Save the OAuth client you made in a provider's console (Google's, in your Cloud project). */
export async function saveOAuthClient(input: Inputs["accounts"]["saveClient"]): Promise<Ok> {
  await saveOwnerClient(input);
  return { ok: true };
}

/** Start connecting an account, tied to this session. Returns the provider's sign-in page. */
export async function startAccountConnect(
  input: Inputs["accounts"]["connect"],
  sessionId: string,
): Promise<{ url: string }> {
  const url = await startAuthorization({
    sessionId,
    kind: input.kind,
    // Each kind keeps only its own (`normalizeCapabilities`), so unknown names drop out there.
    capabilities: input.capabilities as AccountCapability[],
    botIds: input.teammateIds,
    accountId: input.accountId,
  });
  return { url };
}

/**
 * Change what an account connection allows and who uses it. When it allows more than the account
 * granted, nothing changes and `needsConsent` says to sign in again for it.
 */
export async function saveAccountConnection(
  input: Inputs["accounts"]["update"],
): Promise<{ needsConsent: boolean }> {
  return worker.connections.updateAccount(input);
}
