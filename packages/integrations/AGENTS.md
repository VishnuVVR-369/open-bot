# packages/integrations

Signing in to the owner's accounts (Google, Notion) and the encrypted token store, in Node with the database.
Provider and integration definitions (labels, scopes, tools) go in `packages/domain/src/integrations/accounts`.
Calls to Gmail, Calendar and Notion, and the teammate tools, go in `apps/worker/src/accounts`.

## Layout

- `packages/integrations/src/core`: what every provider shares.
  `provider.ts` defines `ProviderAdapter`, `oauth.ts` has the PKCE and token exchange helpers, `endpoints.ts` has endpoints with env overrides, `clients.ts` stores OAuth clients and `store.ts` is the token store.
- `packages/integrations/src/providers/<provider>`: one folder per provider; `oauth.ts` is its `ProviderAdapter`.
- `packages/integrations/src/provider-registry.ts`: `PROVIDER_ADAPTERS`, one line per provider.

## Entry points

- `@open-bot/integrations/server` is `packages/integrations/src/server.ts`: sign-in and tokens, for the web app and the worker.
- It is Node-only: lint refuses it in browser and phone code.

## Why definitions live in packages/domain

- `packages/db` types its columns with the provider, integration and capability unions, and this package needs `packages/db`, so the definitions must sit below both.
- `packages/domain/src/integrations/accounts` has no Node or database code, so web and mobile read it too.
- Teammates get tools, never provider tokens or client secrets.

## Invariants

- Tokens and client secrets are encrypted with `encryptSecret` from `@open-bot/domain/server` before they are stored.
- A refresh can fail permanently; the store then raises `AccountUnavailableError` and the account needs a reconnect.
- Tokens within two minutes of expiry are refreshed first (`REFRESH_MARGIN_MS` in `packages/integrations/src/core/store.ts`).
- Provider-specific behavior stays behind `ProviderAdapter`; the store and callers do not branch on provider.
- Tests and e2e runs point the endpoints at a stand-in through the env overrides, never at the real providers.
- The `accounts` table is unrelated to Better Auth's `account` table.

## Tests

- `pnpm test:integration` runs `packages/integrations/src/core/store.integration.test.ts` and the other integration suites.
- `pnpm --filter @open-bot/integrations typecheck` checks types.
- `e2e/accounts.spec.ts` runs against `e2e/accounts-stand-in.ts`.

## Docs

- `apps/site/src/app/docs/flows/accounts/page.mdx`
- The recipe is "Add an account provider" in the root `AGENTS.md`.
