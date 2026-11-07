# packages/egress

The tunnel that sends the computer's browser traffic out through the owner's Mac or phone: frames, the mux, IP policy, SOCKS and the agent.
The relay lives in `apps/worker/src/egress`, the Mac app in `apps/desktop`, and the Kotlin agent in `apps/mobile/modules/egress`.

## Entry points

- `packages/egress/src/index.ts` is the only export (`.`).
- `packages/egress/src/frames.ts` is the wire format; `packages/egress/src/mux.ts` is stream multiplexing and flow control.
- `packages/egress/src/ip-policy.ts` decides which addresses an agent may dial.
- `packages/egress/src/socks.ts` is the SOCKS side used by botd; `packages/egress/src/agent.ts` runs inside Electron.
- `packages/egress/src/vectors.ts` builds the test vectors in `packages/egress/test-vectors/`.

## Invariants

- The Kotlin agent implements the same protocol. The JSON files in `packages/egress/test-vectors/` are the shared contract.
- After any change to frames, mux or IP policy, regenerate the vectors and commit them.
- `packages/egress/src/vectors.test.ts` fails when the committed files differ from what the code produces.
- Agents refuse non-public addresses (`resolvePublicAddress`); do not weaken this for convenience.
- The computer image bundles this package, so botd changes need a rebuild (`pnpm computer:build`).

## Vectors flow

1. `pnpm --filter @open-bot/egress vectors` rewrites `packages/egress/test-vectors/`.
2. `./gradlew test` in `apps/mobile/modules/egress/core` checks Kotlin against the same files.

## Tests

- `pnpm --filter @open-bot/egress test` runs `egress.test.ts`, `flow.test.ts` and `vectors.test.ts`.
- `apps/web/src/lib/server/egress-device.integration.test.ts` is the nearest integration suite (`pnpm test:integration`).
- See the openbot-computer skill for sleep and wake and egress behavior.

## Docs

- `apps/site/src/app/docs/architecture/desktop-and-egress/page.mdx`
- `apps/site/src/app/docs/development/page.mdx`
