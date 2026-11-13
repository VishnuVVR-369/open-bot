# packages/integrations

Everything particular to each account provider (Google, Notion), in Node with the database: signing in, the encrypted token store, and the adapters that serve Gmail, Calendar and Notion to teammates.
Provider and integration definitions (labels, scopes, tool names) go in `packages/domain/src/integrations/accounts`.
What every integration shares at run time (access checks, approvals, the durable action executor, timeline items) stays in `apps/worker/src/accounts`.

## Layout

- `packages/integrations/src/core`: what every provider shares.
  - Sign-in: `provider.ts` defines `ProviderAdapter`, `oauth.ts` has the PKCE and token exchange helpers, `endpoints.ts` has the providers' endpoints (`integrationEndpoints()`), `clients.ts` stores OAuth clients and `store.ts` is the token store.
  - Adapters: `adapter.ts` defines `IntegrationAdapter`, `ToolContext` and the action runner, `tool-spec.ts` describes tools to Codex, `http.ts` has `ProviderError` and `TokenSource`, and `errors.ts` has `AccountToolError`.
- `packages/integrations/src/providers/<provider>`: one folder per provider.
  `oauth.ts` is its `ProviderAdapter`; each integration it serves has an `adapter.ts` (Notion's is at the provider's root), with its API client in `api.ts` when it has one.
- `packages/integrations/src/provider-registry.ts`: `providerAdapters()`, one line per provider.
- `packages/integrations/src/integration-registry.ts`: `ADAPTERS`, one line per integration, checked against the definitions when the worker starts (`Integrations.create()`).

## Entry points

- `@open-bot/integrations/server` is `packages/integrations/src/server.ts`: sign-in and tokens, for the web app and the worker.
- `@open-bot/integrations/adapters` is `packages/integrations/src/adapters.ts`: the integrations' adapters, for the worker only.
  It pulls in the MCP SDK, which the web app must not bundle.
- Both are Node-only: lint refuses the package in browser and phone code.

## Why definitions live in packages/domain

- `packages/db` types its columns with the provider, integration and capability unions, and this package needs `packages/db`, so the definitions must sit below both.
- `packages/domain/src/integrations/accounts` has no Node or database code, so web and mobile read it too.
- Teammates get tools, never provider tokens or client secrets.

## Invariants

- Tokens and client secrets are encrypted with `encryptSecret` from `@open-bot/domain/server` before they are stored.
- A refresh can fail permanently; the store then raises `AccountUnavailableError` and the account needs a reconnect.
- Tokens within two minutes of expiry are refreshed first (`REFRESH_MARGIN_MS` in `packages/integrations/src/core/store.ts`).
- Provider-specific behavior stays behind `ProviderAdapter` and `IntegrationAdapter`; the store, the worker and the web app do not branch on provider.
- An adapter only reads and prepares changes; it never runs a change itself outside its runner, which the worker's executor calls.
- The package never reads `process.env` (lint enforces it).
  Each app builds `IntegrationEndpoints` from its env module and passes it to `AccountStore` and the adapters, so tests and e2e runs point every call at a stand-in, never at the real providers.
- The `accounts` table is unrelated to Better Auth's `account` table.

## Tests

- `pnpm --filter @open-bot/integrations test` runs the unit tests next to the code.
- `pnpm test:integration` runs `packages/integrations/src/core/store.integration.test.ts` and the other integration suites.
- `pnpm --filter @open-bot/integrations typecheck` checks types.
- `e2e/accounts.spec.ts` runs against `e2e/stand-ins/accounts.ts`, which serves Google (`google.ts`, `gmail.ts`, `calendar.ts`) and Notion (`notion.ts`) from that folder on one port.

## Docs

- `apps/site/src/app/docs/flows/accounts/page.mdx`
- `apps/site/src/app/docs/architecture/worker/page.mdx` (Accounts)
- The recipe is "Add an account provider" in the root `AGENTS.md`.
