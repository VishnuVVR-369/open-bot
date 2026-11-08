# packages/accounts

OAuth flows and the encrypted token store for Google and Notion, in Node with the database.
Provider and integration definitions (labels, scopes, tools) go in `packages/domain/src/integrations/accounts`.
Calls to Gmail, Calendar and Notion, and the teammate tools, go in `apps/worker/src/accounts`.

## Entry points

- `packages/accounts/src/index.ts` is the only export (`.`).
- `packages/accounts/src/provider.ts` defines `ProviderAdapter`; `packages/accounts/src/providers.ts` registers them in `PROVIDER_ADAPTERS`.
- `packages/accounts/src/google.ts` and `packages/accounts/src/notion.ts` are the adapters.
- `packages/accounts/src/oauth.ts` has the PKCE and token exchange helpers; `packages/accounts/src/endpoints.ts` has endpoints with env overrides.
- `packages/accounts/src/clients.ts` stores owner-supplied OAuth clients; `packages/accounts/src/store.ts` is the token store.

## Why accounts are split in three

- `packages/domain/src/integrations/accounts`: isomorphic definitions, readable by web and mobile.
- `packages/accounts`: the OAuth flows and token store, which need Node and the database.
- `apps/worker/src/accounts`: runtime adapters that serve the tools.
- Teammates get tools, never provider tokens or client secrets.

## Invariants

- Tokens and client secrets are encrypted with `encryptSecret` from `@open-bot/domain/server` before they are stored.
- A refresh can fail permanently; the store then raises `AccountUnavailableError` and the account needs a reconnect.
- Tokens within two minutes of expiry are refreshed first (`REFRESH_MARGIN_MS` in `packages/accounts/src/store.ts`).
- Provider-specific behavior stays behind `ProviderAdapter`; the store and callers do not branch on provider.
- Tests and e2e runs point the endpoints at a stand-in through the env overrides, never at the real providers.
- The `accounts` table is unrelated to Better Auth's `account` table.

## Tests

- `pnpm test:integration` runs `packages/accounts/src/store.integration.test.ts` and the other integration suites.
- `pnpm --filter @open-bot/accounts typecheck` checks types.
- `e2e/accounts.spec.ts` runs against `e2e/accounts-stand-in.ts`.

## Docs

- `apps/site/src/app/docs/flows/accounts/page.mdx`
- The recipe is "Add an account provider" in the root `AGENTS.md`.
