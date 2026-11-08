# apps/desktop

The Electron Mac app: it wraps the web app, shows native notifications and runs the egress agent so browsing can leave through the owner's Mac.
It has no UI of its own beyond the tray, and it does not hold app logic: screens belong in `apps/web`, and tunnel logic in `packages/egress`.
"Desktop" in this repo means only this app (a computer's screen is a "screen").

## Entry points

- `apps/desktop/src/main.ts`: main process with the window, tray, quick-capture shortcut, `openbot://` links and `EgressAgent`.
- `apps/desktop/src/preload.ts`: exposes only `openBotDesktop.platform` to the page.
- `apps/desktop/build.mjs`: esbuild to `apps/desktop/dist/main.cjs` and `apps/desktop/dist/preload.cjs` (electron stays external).
- `apps/desktop/assets`: app and tray icons.
- `pnpm --filter @open-bot/desktop dev` builds and starts it; `package` builds a dmg and zip into `apps/desktop/release`.

## Invariants

- The window keeps `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` and `webviewTag: false`.
- Only the app's own origin (`OPEN_BOT_URL`) stays in the window; other links open in the default browser.
- The preload exposes nothing beyond the platform string.
- Permissions are granted only to the app's own origin, and only for notifications, the clipboard and fullscreen.
- The egress agent signs in with the app's session cookie via `/api/desktop/egress-token`, so there is nothing to pair. Its answer is `desktopEgressTokenSchema` (`packages/api/src/desktop.ts`), which the web route produces and the app checks; installed apps call that path, so it stays.
- Closing the window hides it and the tray keeps egress running; only an explicit quit stops it.
- `@open-bot/egress` and `@open-bot/api` are devDependencies because esbuild bundles them into `dist/main.cjs`; import only `@open-bot/api/desktop`, which needs nothing but zod.

## Tests

- There are no automated tests; run `pnpm --filter @open-bot/desktop typecheck` and `pnpm --filter @open-bot/desktop build`.
- Tunnel behavior is covered by `pnpm --filter @open-bot/egress test`.
- The worker side of the tunnel is covered by `apps/worker/src/egress/relay.test.ts`.
- Anything needing the real app, tray or notifications is a manual check on a Mac; list it as untested otherwise.

## Docs

- `apps/site/src/app/docs/architecture/desktop-and-egress/page.mdx`
- `apps/site/src/app/docs/security/page.mdx`
