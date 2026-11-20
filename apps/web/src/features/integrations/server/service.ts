import "server-only";
import type { ApiInputs, ApiOutputs } from "@open-bot/api";
import { accounts, teammates, connections } from "@open-bot/db";
import {
  ACCOUNT_PROVIDERS,
  authProvider,
  integrationSettings,
  missingCapabilities,
  type AccountCapability,
} from "@open-bot/domain";
import { asc, eq, isNull, sql } from "drizzle-orm";
import { syncWorkspace } from "@/features/teammates/server";
import { accountRedirectUri, accountStore, saveOwnerClient, startAuthorization } from "./accounts";
import { db } from "@/lib/server/db";
import { worker } from "@/lib/server/worker";
import type { AccountsSetupView, AccountView, ConnectionView, EmailStatusView } from "@/lib/types";

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

/* ------------------------------------------------------------------ Reads */

export async function listConnections(): Promise<ConnectionView[]> {
  const rows = await db
    .select({ connection: connections, account: accounts })
    .from(connections)
    .leftJoin(accounts, eq(accounts.id, connections.accountId))
    .orderBy(asc(sql`lower(${connections.label})`));
  return rows.map(({ connection: row, account }) => ({
    id: row.id,
    label: row.label,
    name: row.name,
    kind: row.kind,
    transport: row.transport,
    url: row.url,
    command: row.command,
    args: row.args,
    secretNames: row.secretNames,
    teammateIds: row.teammateIds,
    enabled: row.enabled,
    updatedAt: row.updatedAt.toISOString(),
    account: account ? toAccountView(account) : null,
    capabilities: row.capabilities,
    missingCapabilities:
      account && row.kind !== "mcp"
        ? missingCapabilities(row.kind, row.capabilities, account.scopes)
        : [],
    askBeforeActing: row.askBeforeActing,
    settings:
      row.kind === "mcp"
        ? []
        : integrationSettings(row.kind).flatMap((setting) => {
            const value = row.settings[setting.key];
            return value
              ? [{ key: setting.key, id: value.id, title: value.title, url: value.url }]
              : [];
          }),
  }));
}

/**
 * What connecting needs, per provider: whether its client is set up (yours, for providers that
 * take one), and the redirect address to register. And the accounts signed in, to reuse.
 */
export async function getAccountsSetup(): Promise<AccountsSetupView> {
  const rows = await db.select().from(accounts).orderBy(asc(accounts.createdAt));
  const providers = await Promise.all(
    ACCOUNT_PROVIDERS.map(async (id) => {
      const definition = authProvider(id);
      const current = definition.client === "owner" ? await accountStore.clients.current(id) : null;
      return {
        id,
        label: definition.label,
        client: definition.client,
        configured: definition.client === "automatic" || current !== null,
        hint: current?.hint ?? null,
        redirectUri: accountRedirectUri(id),
      };
    }),
  );
  return { providers, accounts: rows.map(toAccountView) };
}

/** Email setup; the worker reads it, since the first read makes the row (it owns it). */
export async function getEmailStatus(): Promise<EmailStatusView> {
  return worker.email.status();
}

function toAccountView(row: typeof accounts.$inferSelect): AccountView {
  return {
    id: row.id,
    provider: row.provider,
    display: row.display,
    status: row.status,
    lastError: row.lastError,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: grantEnds(row),
  };
}

/** When the provider ends the grant however it's used, if it does. */
function grantEnds(row: typeof accounts.$inferSelect): string | null {
  const days = authProvider(row.provider).grantMaxDays;
  return days ? new Date(row.grantedAt.getTime() + days * 86_400_000).toISOString() : null;
}
