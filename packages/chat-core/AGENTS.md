# packages/chat-core

Chat logic the web app (`apps/web`) and the Android app (`apps/mobile`) share, so each app's components only render.
Everything here is a pure function or plain data: what a turn shows, how its parts are worded, and how numbers and times read.
Shapes and rules the servers also use belong in `packages/domain`; the API's views and live events in `packages/api`.

## Layout

- `packages/chat-core/src/format.ts`: counts, the work stopwatch, file sizes, the greeting and diff line counts.
- `packages/chat-core/src/timeline.ts`: a turn's parts (`turnParts`: computer stretches, steps that only repeat the next one, approved commands, the step count), what stays pinned when steps fold, the reply text, what the teammate is doing, and how long it worked.
- `packages/chat-core/src/triggers.ts`: what started a turn, as `{ kind, text, automation }`; each app maps `kind` to its icon.
- `packages/chat-core/src/mentions.ts`: @mentions in a group chat: who a message mentions, and the composer's @ menu.
- `packages/chat-core/src/search.ts`: search as you type, matching where words start, with ranking, highlights and excerpts.
- `packages/chat-core/src/send.ts`: the id a message is sent with, kept when you send the same thing again so it is saved once.
- `packages/chat-core/src/index.ts` re-exports every module; import from `@open-bot/chat-core`.

## Invariants

- No React Native, DOM, Next.js, Expo or Node imports, and no server-only packages; lint enforces it (`scripts/check/import-boundaries.test.mjs`).
- Return data, not elements or icons: an app maps a kind to its own icon and styles.
- When web and mobile disagreed, one behavior was picked here; change it here, not in one app.
- Only web and mobile use it; the worker and botd never import it.

## Tests

- `pnpm --filter @open-bot/chat-core test` runs the Vitest suites next to the code.
- `pnpm --filter @open-bot/chat-core typecheck` checks types.
- A change shows on both apps, so follow the openbot-ui-review skill for web and mobile screenshots.

## Docs

- `apps/site/src/app/docs/architecture/page.mdx`
- `apps/site/src/app/docs/architecture/mobile/page.mdx`
