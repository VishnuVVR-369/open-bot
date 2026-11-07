# packages/agent

A client for the Codex app-server (JSON-RPC over WebSocket) that the worker uses to drive teammates.
Run orchestration, tools and instructions go in `apps/worker`, and the process itself runs on the computer through `apps/botd`.

## Entry points

- `packages/agent/src/index.ts` is the only export (`.`): the client plus protocol types.
- `packages/agent/src/client.ts` has the client and the `Methods` map of app-server calls open-bot uses.
- `packages/agent/src/protocol` is the generated Codex protocol; `protocol/v2` is re-exported as `v2`.

## Invariants

- `packages/agent/src/protocol` is generated and never edited by hand.
- Regenerate it with `pnpm --filter @open-bot/agent generate:protocol`. The script deletes the folder first, then runs `codex app-server generate-ts --experimental`.
- Regenerate with the same Codex version the computer image installs (`CODEX_VERSION` in `images/computer/Dockerfile`), and commit the result.
- Only the app-server methods listed in `Methods` are typed; add a method there before calling it.
- Consumers import types only from `./protocol`; there is no runtime code in the generated folder.
- The package depends on `ws`; the worker bundler must resolve it (`apps/worker/build.mjs`).

## Tests

- `pnpm --filter @open-bot/agent test` runs `packages/agent/src/client.test.ts`.
- `pnpm --filter @open-bot/agent typecheck` checks the generated types against the client.
- After a Codex upgrade, also run `pnpm --filter @open-bot/worker test` and `e2e/agent.spec.ts` with `--grep @agent`.

## Docs

- `apps/site/src/app/docs/architecture/agent-runtime/page.mdx`
- `apps/site/src/app/docs/flows/chat-turn/page.mdx`
