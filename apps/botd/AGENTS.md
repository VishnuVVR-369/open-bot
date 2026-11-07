# apps/botd

The daemon inside the computer: it starts every process, owns every screen, runs Chromium and VNC, proxies Codex and holds leases.
It does not decide when the computer sleeps or wakes (that is `apps/worker/src/computer-lifecycle.ts`), and the image and filesystem overlay live in `images/computer`.
Tunnel framing and IP policy live in `packages/egress`.

## Entry points

- `apps/botd/src/index.ts`: process entry that probes the sandbox and starts the supervisor, server and Codex.
- `apps/botd/src/server.ts`: HTTP and WebSocket API, `/healthz`, `/lifecycle/*` and the Codex bridge.
- `apps/botd/src/screens.ts`, `apps/botd/src/lease.ts`, `apps/botd/src/desktop.ts`, `apps/botd/src/cdp.ts`: screens, input leases, display and browser control.
- `apps/botd/src/lifecycle.ts`: `ComputeLifecycle`, the sleep and quiesce state machine.
- `apps/botd/src/supervisor.ts`, `apps/botd/src/egress.ts`, `apps/botd/src/pages.ts`, `apps/botd/src/cookies.ts`: process restarts, phone and desktop egress, page preview and checks, shared cookie jar.
- Build: `pnpm --filter @open-bot/botd build` writes `apps/botd/dist/botd.mjs`, which `images/computer/Dockerfile` copies to `/opt/botd/botd.mjs`.

## Invariants

- Railway blocks user namespaces, so `browserSandboxAvailable()` in `apps/botd/src/sandbox.ts` probes and Chromium falls back to `--no-sandbox`.
- A fix that works in local Docker is not done until it holds under Railway constraints.
- botd must not keep the computer awake: failed or cancelled work does not count as activity, and a lost controller or expired lease never stops compute on its own.
- Reading status (`/healthz`, `/lifecycle/capabilities`) must not begin activity or wake the computer.
- Watching a screen never starts it; `ScreenManager.ensure()` does, and a screen a run or the owner holds is never stopped.
- Anything that touches a display runs as the `desktop` user, and nothing in the `bot` user's reach may get display access.
- Teammates must never submit a job application; the `*apply*` request pause in the browser setup must stay.
- Async changes need tests for cancellation, late callbacks after shutdown, stale messages after reconnect, readiness on both socket ends and state saved at shutdown.

## Tests

- `pnpm --filter @open-bot/botd test` and `pnpm --filter @open-bot/botd typecheck`.
- Lifecycle suites: `apps/botd/src/lifecycle.test.ts`, `apps/botd/src/server-lifecycle.test.ts`.
- Built artifact and image: `pnpm computer:build`.
- Sleep and wake against the real image: `pnpm test:computer-sleep`; E2E: `e2e/computer.spec.ts`.

## Docs

- `apps/site/src/app/docs/architecture/computer/page.mdx`
- `apps/site/src/app/docs/flows/screens-and-takeover/page.mdx`
- `apps/site/src/app/docs/architecture/desktop-and-egress/page.mdx`
- `apps/site/src/app/docs/security/page.mdx`
