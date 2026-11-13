import "server-only";
import {
  AccountIdentityError,
  AccountStore,
  OAuthError,
  integrationEndpoints,
  pkce,
  randomToken,
  redirectUri,
} from "@open-bot/integrations/server";
import { accounts, connections, oauthStates, type OAuthPurpose } from "@open-bot/db";
import {
  authProvider,
  integration,
  missingCapabilities,
  normalizeCapabilities,
  scopesFor,
  type AccountCapability,
  type AccountConnectionKind,
  type AccountProvider,
} from "@open-bot/domain";
import { decryptSecret, encryptSecret } from "@open-bot/domain/server";
import { and, eq, lt } from "drizzle-orm";
import { ApiError } from "@/lib/server/api/errors";
import { BASE_URL } from "@/lib/server/auth-config";
import { db } from "@/lib/server/db";
import { serverEnv } from "@/lib/server/env";
import { publish } from "@/lib/server/publish";
import { worker, WorkerError } from "@/lib/server/worker";

/** How long a sign-in may take, from pressing Connect to coming back. */
const STATE_TTL_MS = 10 * 60_000;

export const accountStore = new AccountStore(
  db,
  serverEnv.encryptionKey,
  integrationEndpoints({
    googleBaseUrl: serverEnv.googleBaseUrl,
    notionMcpUrl: serverEnv.notionMcpUrl,
  }),
);

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
  const adapter = accountStore.provider(provider);
  const capabilities = normalizeCapabilities(input.kind, input.capabilities);
  const account = input.accountId
    ? (await db.select().from(accounts).where(eq(accounts.id, input.accountId)))[0]
    : undefined;
  if (input.accountId && !account)
    throw new AccountConnectError("That account is gone.", "NOT_FOUND");
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
  const adapter = accountStore.provider(input.provider);
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

    const { account } = await accountStore.saveGrant({
      provider: input.provider,
      externalId: identity.externalId,
      oauthClientId: client.id,
      display: identity.display,
      tokens,
      ...(purpose.accountId ? { expectedAccountId: purpose.accountId } : {}),
    });
    // The worker makes or changes the connection (it owns connections, see packages/db/src/owners.ts).
    const { connectionId } = await worker.connections.linkAccount({
      accountId: account.id,
      kind: purpose.kind,
      capabilities: purpose.capabilities,
      teammateIds: purpose.botIds,
    });
    return {
      connectionId,
      missing: missingCapabilities(purpose.kind, purpose.capabilities, account.scopes),
      error: null,
    };
  } catch (error) {
    if (error instanceof AccountIdentityError || error instanceof OAuthError)
      return fail(error.message);
    // The grant is saved; signing in again finishes connecting it.
    if (error instanceof WorkerError)
      return fail("You signed in, but open-bot couldn't save the connection. Try again.");
    throw error;
  }
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
  const adapter = accountStore.provider(input.provider);
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
