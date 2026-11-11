import "server-only";
import {
  AccountIdentityError,
  AccountStore,
  OAuthError,
  pkce,
  providerAdapter,
  randomToken,
  redirectUri,
} from "@open-bot/accounts";
import {
  accountActions,
  accounts,
  approvals,
  CHANNELS,
  connections,
  notify,
  oauthStates,
  type OAuthPurpose,
} from "@open-bot/db";
import {
  authProvider,
  capabilityGranted,
  connectionName,
  integration,
  integrationSettings,
  missingCapabilities,
  normalizeCapabilities,
  scopesFor,
  type AccountCapability,
  type AccountConnectionKind,
  type AccountProvider,
  type ConnectionSettings,
} from "@open-bot/domain";
import { decryptSecret, encryptSecret } from "@open-bot/domain/server";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { ApiError } from "./api/errors";
import { BASE_URL } from "./auth-config";
import { claimConnectionName } from "./connection-names";
import { db, pool } from "./db";
import { serverEnv } from "./env";
import { publish } from "./publish";

/** How long a sign-in may take, from pressing Connect to coming back. */
const STATE_TTL_MS = 10 * 60_000;

export const accountStore = new AccountStore(db, serverEnv.encryptionKey);

/** Connecting or changing an account can't go ahead, for the reason it says. */
export class AccountConnectError extends ApiError {
  constructor(message: string, code: "BAD_REQUEST" | "NOT_FOUND" = "BAD_REQUEST") {
    super(code, message);
  }
}

/**
 * Start signing in to a provider for a connection: save a single-use state tied to this session,
 * and return the provider's sign-in URL. What differs between providers is their adapter's.
 */
export async function startAuthorization(input: {
  sessionId: string;
  kind: AccountConnectionKind;
  capabilities: AccountCapability[];
  botIds: string[] | null;
  /** Reuse, reconnect or widen this account (it must sign in as the same identity). */
  accountId: string | null;
}): Promise<string> {
  const provider = integration(input.kind).provider;
  const adapter = providerAdapter(provider);
  const capabilities = normalizeCapabilities(input.kind, input.capabilities);
  const account = input.accountId
    ? (await db.select().from(accounts).where(eq(accounts.id, input.accountId)))[0]
    : undefined;
  if (input.accountId && !account) throw new AccountConnectError("That account is gone.", "NOT_FOUND");
  if (account && account.provider !== provider)
    throw new AccountConnectError(`That isn't a ${authProvider(provider).accountLabel}.`);

  const state = randomToken();
  const { verifier, challenge } = pkce();
  const callback = redirectUri(BASE_URL, provider);
  let client;
  try {
    client = await adapter.signInClient(accountStore.clients, callback);
  } catch (error) {
    if (error instanceof OAuthError) throw new AccountConnectError(error.message);
    throw error;
  }
  // Every scope the account's other connections use too, so a new grant never narrows them.
  const scopes = new Set(scopesFor(input.kind, capabilities));
  if (account) {
    const siblings = await db
      .select({ kind: connections.kind, capabilities: connections.capabilities })
      .from(connections)
      .where(eq(connections.accountId, account.id));
    for (const sibling of siblings)
      if (sibling.kind !== input.kind && sibling.kind !== "mcp")
        for (const scope of scopesFor(sibling.kind, sibling.capabilities)) scopes.add(scope);
  }
  const url = await adapter.authorizationUrl({
    client,
    redirectUri: callback,
    scopes: [...scopes],
    state,
    challenge,
    account: account
      ? { display: account.display, oauthClientId: account.oauthClientId, status: account.status }
      : null,
  });

  const purpose: OAuthPurpose = {
    kind: input.kind,
    capabilities,
    botIds: input.botIds,
    oauthClientId: client.id,
    ...(account ? { accountId: account.id, expectedExternalId: account.externalId } : {}),
  };
  await db.delete(oauthStates).where(lt(oauthStates.expiresAt, new Date()));
  await db.insert(oauthStates).values({
    state,
    provider,
    verifier: encryptSecret(verifier, serverEnv.encryptionKey),
    sessionId: input.sessionId,
    purpose,
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });
  return url;
}

export interface CallbackOutcome {
  connectionId: string | null;
  /** Capabilities you picked that the provider's consent screen left out. */
  missing: AccountCapability[];
  error: string | null;
}

/**
 * The provider sent you back. Checks the state (single use, this session, not expired), exchanges
 * the code with the client the sign-in started with, and stores the account and its connection.
 */
export async function completeAuthorization(input: {
  provider: AccountProvider;
  sessionId: string;
  state: string | null;
  code: string | null;
  error: string | null;
}): Promise<CallbackOutcome> {
  const fail = (error: string): CallbackOutcome => ({ connectionId: null, missing: [], error });
  if (!input.state) return fail("The sign-in came back without its state. Try again.");
  // Used once: deleting it is what claims it.
  const [state] = await db
    .delete(oauthStates)
    .where(eq(oauthStates.state, input.state))
    .returning();
  if (!state || state.provider !== input.provider)
    return fail("That sign-in isn't one open-bot started, or it was already used. Try again.");
  if (state.sessionId !== input.sessionId)
    return fail("That sign-in was started in another session. Try again from here.");
  if (state.expiresAt.getTime() < Date.now()) return fail("The sign-in took too long. Try again.");
  if (input.error)
    return fail(
      input.error === "access_denied"
        ? "You didn't allow access, so nothing was connected."
        : `The provider said: ${input.error}.`,
    );
  if (!input.code) return fail("The sign-in came back without a code. Try again.");

  const verifier = decryptSecret(state.verifier, serverEnv.encryptionKey);
  const purpose = state.purpose;
  const adapter = providerAdapter(input.provider);
  const label = authProvider(input.provider).label;
  const callback = redirectUri(BASE_URL, input.provider);
  const client = await accountStore.clients.byId(purpose.oauthClientId);
  if (!client || client.provider !== input.provider)
    return fail(`The ${label} sign-in setup changed meanwhile. Try again.`);
  try {
    const tokens = await adapter.exchange(client, input.code, verifier, callback);
    const identity = await adapter.identity(tokens);

    if (purpose.expectedExternalId && identity.externalId !== purpose.expectedExternalId) {
      // The grant just made is for someone else. Revoke it, unless that someone is another
      // account you connected (revoking at Google would end that account's access too).
      const [other] = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(eq(accounts.provider, input.provider), eq(accounts.externalId, identity.externalId)),
        );
      if (!other)
        await adapter
          .revoke(client, tokens.refreshToken ?? tokens.accessToken)
          .catch(() => undefined);
      return fail(
        `You signed in as ${identity.display}, but this connection uses a different account. Sign in with that one.`,
      );
    }

    const { account, grantChanged } = await accountStore.saveGrant({
      provider: input.provider,
      externalId: identity.externalId,
      oauthClientId: client.id,
      display: identity.display,
      tokens,
      ...(purpose.accountId ? { expectedAccountId: purpose.accountId } : {}),
    });
    if (grantChanged) await cancelForAccount(account.id);
    const connectionId = await upsertConnection(account.id, account.display, purpose);
    await publish({ type: "connections" });
    return {
      connectionId,
      missing: missingCapabilities(purpose.kind, purpose.capabilities, account.scopes),
      error: null,
    };
  } catch (error) {
    if (error instanceof AccountIdentityError || error instanceof OAuthError)
      return fail(error.message);
    throw error;
  }
}

/**
 * The grant lost something approvals may rely on (a scope, or the client it was made to): what
 * waits on any of the account's connections never runs, and its approval cards close.
 */
async function cancelForAccount(accountId: string): Promise<void> {
  const rows = await db
    .select({ id: connections.id })
    .from(connections)
    .where(eq(connections.accountId, accountId));
  if (rows.length === 0) return;
  await db.transaction(async (tx) => {
    for (const row of rows)
      await cancelPending(
        tx,
        row.id,
        "You signed in again with different access since it was asked for.",
      );
  });
  await wakeAccounts();
}

/** The account's connection of this kind: created, or given the capabilities you picked. */
async function upsertConnection(
  accountId: string,
  display: string,
  purpose: OAuthPurpose,
): Promise<string> {
  const definition = integration(purpose.kind);
  const [existing] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.accountId, accountId), eq(connections.kind, purpose.kind)));
  if (existing) {
    // Signing in again changes nothing teammates asked for, unless what's allowed changed.
    if (
      sameList(existing.capabilities, purpose.capabilities) &&
      sameList(existing.botIds, purpose.botIds)
    )
      return existing.id;
    await db.transaction(async (tx) => {
      await tx
        .update(connections)
        .set({
          capabilities: purpose.capabilities,
          botIds: purpose.botIds,
          revision: sql`${connections.revision} + 1`,
        })
        .where(eq(connections.id, existing.id));
      await cancelPending(tx, existing.id, "You changed this connection after it was asked for.");
    });
    await wakeAccounts();
    return existing.id;
  }
  return db.transaction(async (tx) => {
    const name = await claimConnectionName(tx, connectionName(definition.label));
    const others = await tx
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.kind, purpose.kind));
    const [row] = await tx
      .insert(connections)
      .values({
        kind: purpose.kind,
        label: others.length ? `${definition.label} (${display})` : definition.label,
        name,
        accountId,
        capabilities: purpose.capabilities,
        botIds: purpose.botIds,
      })
      .returning({ id: connections.id });
    return row!.id;
  });
}

/** Two teammate or capability lists hold the same entries (null is "everyone"). */
function sameList(a: readonly string[] | null, b: readonly string[] | null): boolean {
  return a === null || b === null ? a === b : [...a].sort().join() === [...b].sort().join();
}

/**
 * Change what a connection allows, who may use it, or how it asks. Returns whether the account
 * must grant more scopes first (then nothing changed; start a sign-in for them).
 *
 * Only a change to what it allows or who uses it counts as a new setup: that bumps its revision,
 * and actions waiting on the old one are cancelled. Changing how it asks, or its settings (like
 * Notion's teammates' area), keeps them.
 */
export async function updateAccountConnection(input: {
  id: string;
  capabilities: AccountCapability[];
  botIds: string[] | null;
  askBeforeActing: boolean;
  /** What you typed for the integration's settings, by key: "" clears one, a missing key keeps it. */
  settings?: Record<string, string>;
}): Promise<{ needsConsent: boolean }> {
  const [row] = await db.select().from(connections).where(eq(connections.id, input.id));
  if (!row || row.kind === "mcp" || !row.accountId)
    throw new AccountConnectError("That connection is gone.", "NOT_FOUND");
  const kind = row.kind;
  const capabilities = normalizeCapabilities(kind, input.capabilities);
  const settings = input.settings ? parseSettings(kind, row.settings, input.settings) : null;
  const [account] = await db.select().from(accounts).where(eq(accounts.id, row.accountId));
  if (!account) throw new AccountConnectError("Its account is gone.", "NOT_FOUND");
  if (capabilities.some((capability) => !capabilityGranted(kind, capability, account.scopes)))
    return { needsConsent: true };
  const changed = !sameList(row.capabilities, capabilities) || !sameList(row.botIds, input.botIds);
  await db.transaction(async (tx) => {
    await tx
      .update(connections)
      .set({
        capabilities,
        botIds: input.botIds,
        askBeforeActing: input.askBeforeActing,
        ...(settings ? { settings } : {}),
        ...(changed ? { revision: sql`${connections.revision} + 1` } : {}),
      })
      .where(eq(connections.id, row.id));
    if (changed)
      await cancelPending(tx, row.id, "You changed this connection after it was asked for.");
  });
  if (changed) await wakeAccounts();
  await publish({ type: "connections" });
  return { needsConsent: false };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Actions still waiting on a connection that changed or went away never run, and their approval
 * cards close. The worker then tells their runs (call `wakeAccounts` after the transaction).
 */
export async function cancelPending(tx: Tx | typeof db, connectionId: string, reason: string) {
  const cancelled = await tx
    .update(accountActions)
    .set({ status: "cancelled", error: reason, finishedAt: new Date() })
    .where(
      and(
        eq(accountActions.connectionId, connectionId),
        inArray(accountActions.status, ["pending", "approved"]),
      ),
    )
    .returning({ approvalId: accountActions.approvalId });
  const approvalIds = cancelled
    .map((row) => row.approvalId)
    .filter((id): id is string => Boolean(id));
  if (approvalIds.length)
    await tx
      .update(approvals)
      .set({ status: "expired", decidedAt: new Date() })
      .where(and(inArray(approvals.id, approvalIds), eq(approvals.status, "pending")));
  return cancelled.length;
}

/** Wake the worker's account actions, to report what was cancelled. */
export async function wakeAccounts(): Promise<void> {
  await notify(pool, CHANNELS.worker, "accounts").catch(() => undefined);
  await publish({ type: "approvals" });
}

/**
 * Remove a connection. Its account's tokens stay while another connection uses the account (one
 * Google sign-in serves Gmail and Calendar); the last one out revokes the grant at the provider.
 */
export async function removeAccountConnection(id: string): Promise<{ warning: string | null }> {
  const [row] = await db.select().from(connections).where(eq(connections.id, id));
  if (!row) return { warning: null };
  await db.transaction(async (tx) => {
    await cancelPending(tx, row.id, "You removed this connection.");
    await tx.delete(connections).where(eq(connections.id, row.id));
  });
  await wakeAccounts();
  let warning: string | null = null;
  if (row.accountId) {
    const [stillUsed] = await db
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.accountId, row.accountId))
      .limit(1);
    if (!stillUsed) warning = (await accountStore.revoke(row.accountId)).warning;
  }
  await publish({ type: "connections" });
  return { warning };
}

/** Turn an account connection on or off. Off cancels what waits on it. */
export async function setAccountConnectionEnabled(id: string, enabled: boolean): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(connections)
      .set({ enabled, revision: sql`${connections.revision} + 1` })
      .where(eq(connections.id, id));
    if (!enabled) await cancelPending(tx, id, "You turned this connection off.");
  });
  if (!enabled) await wakeAccounts();
  await publish({ type: "connections" });
}

/**
 * A connection's settings with what you typed applied, each parsed by its integration. Keys the
 * integration doesn't offer are refused, so nothing else gets stored on the connection.
 */
function parseSettings(
  kind: AccountConnectionKind,
  current: ConnectionSettings,
  typed: Record<string, string>,
): ConnectionSettings {
  const offered = integrationSettings(kind);
  const next: ConnectionSettings = { ...current };
  for (const [key, text] of Object.entries(typed)) {
    const setting = offered.find((entry) => entry.key === key);
    if (!setting)
      throw new AccountConnectError(`${integration(kind).label} has no setting ${key}.`);
    if (!text.trim()) {
      delete next[key];
      continue;
    }
    const value = setting.parse(text);
    if (!value) throw new AccountConnectError(setting.invalid);
    next[key] = value;
  }
  return next;
}

/** The redirect URI to register at a provider. */
export function accountRedirectUri(provider: AccountProvider): string {
  return redirectUri(BASE_URL, provider);
}

/** Save the OAuth client you made in a provider's console, as the one new sign-ins use. */
export async function saveOwnerClient(input: {
  provider: AccountProvider;
  clientId: string;
  clientSecret: string;
}): Promise<void> {
  const adapter = providerAdapter(input.provider);
  if (authProvider(input.provider).client !== "owner" || !adapter.invalidOwnerClient)
    throw new AccountConnectError(`${authProvider(input.provider).label} doesn't take a client.`);
  const client = { clientId: input.clientId.trim(), clientSecret: input.clientSecret.trim() };
  const problem = adapter.invalidOwnerClient(client);
  if (problem) throw new AccountConnectError(problem);
  await accountStore.clients.makeCurrent({
    provider: input.provider,
    source: "owner",
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    hint: adapter.ownerClientHint?.(client) ?? null,
  });
  await publish({ type: "connections" });
}
