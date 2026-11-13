# apps/botd

The daemon inside the computer: it starts every process, owns every screen, runs Chromium and VNC, proxies Codex and holds leases.
It does not decide when the computer sleeps or wakes (that is `apps/worker/src/computer-lifecycle.ts`), and the image and filesystem overlay live in `images/computer`.
Tunnel framing and IP policy live in `packages/egress`.

## Entry points

- `apps/botd/src/index.ts`: process entry that probes the sandbox and starts the supervisor, server and Codex.
- `apps/botd/src/env.ts`: `readEnv()`, the only place botd reads the environment.
- `apps/botd/src/server.ts`: the HTTP server (token check) and the WebSockets: `/events`, the Codex bridge, `/egress` and `/vnc`.
- `apps/botd/src/router.ts`: the HTTP API, implementing `botdContract` (`packages/api/src/botd/contract.ts`); `apps/botd/src/rpc.ts` counts activity and turns errors into statuses.
- `apps/botd/src/screens.ts`, `apps/botd/src/lease.ts`, `apps/botd/src/desktop.ts`, `apps/botd/src/cdp.ts`: screens, input leases, display and browser control.
- `apps/botd/src/lifecycle.ts`: `ComputeLifecycle`, the sleep and quiesce state machine.
- `apps/botd/src/supervisor.ts`, `apps/botd/src/pages.ts`, `apps/botd/src/cookies.ts`: process restarts, page preview and checks, shared cookie jar.
- Phone and desktop egress: botd runs `EgressRouter` from `packages/egress/src/router.ts` (`@open-bot/egress/router`).
- Build: `pnpm --filter @open-bot/botd build` writes `apps/botd/dist/botd.mjs`, which `images/computer/Dockerfile` copies to `/opt/botd/botd.mjs`.

## Invariants

- Railway blocks user namespaces, so `browserSandboxAvailable()` in `apps/botd/src/sandbox.ts` probes and Chromium falls back to `--no-sandbox`.
- botd must not keep the computer awake: failed or cancelled work does not count as activity, and a lost controller or expired lease never stops compute on its own.
- Reading status (`/healthz`, `/health`, `/lifecycle/*`) must not begin activity or wake the computer.
- Every HTTP route is a procedure in `botdContract`. One that works on the computer is built with `work` (`wakesComputer`), so the worker wakes the computer for it and botd counts it as activity; a new route without it can run while the computer quiesces.
- The worker and the computer deploy separately: keep each route's path and input fields until no deployed worker sends them, and keep answers parseable by the deployed worker.
- Watching a screen never starts it; `ScreenManager.ensure()` does, and a screen a run or the owner holds is never stopped.
- Anything that touches a display runs as the `desktop` user, and nothing in the `bot` user's reach may get display access.
- Teammates must never submit a job application; the `*apply*` request pause in the browser setup must stay.
- Async changes are tested against the checklist in the openbot-computer skill.

## Recipes

Paths are relative to the repo root; symbols are in parentheses.

### Add a botd route (called by the worker)

1. Shapes botd sends or takes go in `packages/domain/src/computer/protocol.ts` as zod schemas.
2. `packages/api/src/botd/contract.ts`: add a procedure to `botdContract` with its `route`, input and output. Build it with `work` if it touches the computer, or it will not wake it and botd will not count it as activity.
   Never use `work` for a status read.
3. `apps/botd/src/router.ts`: implement it.
   Throw `ORPCError` with a status for a refusal; `apps/botd/src/rpc.ts` maps every other error in one place.
4. `apps/worker/src/computer.ts`: call it with `this.botd.<domain>.<procedure>(input)` behind a `ComputerClient` method.
   The answer is already validated; failures are `BotdError` with botd's status.
5. The computer and the worker deploy separately: keep old paths and input fields until no deployed worker sends them.
   Test it in `apps/botd/src/contract.test.ts` and document it in `apps/site/src/app/docs/reference/http-api/page.mdx`.

## Tests

- `pnpm --filter @open-bot/botd test` and `pnpm --filter @open-bot/botd typecheck`.
- Lifecycle suites: `apps/botd/src/lifecycle.test.ts`, `apps/botd/src/server-lifecycle.test.ts`.
- The contract through the real server and the worker's client: `apps/botd/src/contract.test.ts`.
- Built artifact and image: `pnpm computer:build`.
- Sleep and wake against the real image: `pnpm test:computer-sleep`; E2E: `e2e/computer.spec.ts`.

## Docs

- `apps/site/src/app/docs/architecture/computer/page.mdx`
- `apps/site/src/app/docs/flows/screens-and-takeover/page.mdx`
- `apps/site/src/app/docs/architecture/desktop-and-egress/page.mdx`
- `apps/site/src/app/docs/security/page.mdx`
