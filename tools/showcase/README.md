# Showcase environment

A second copy of open-bot, filled with realistic demo data, for design review screenshots.
It runs next to your normal dev stack and never touches it.

- Database: `openbot_showcase` on the same Postgres container (the real `openbot` database is never opened).
- Web app: port 3200, with its own Next.js output folder (`.next-showcase`, gitignored).
- Pages service: port 3401, so page previews open.
- Owner: `alex@showcase.local`, password `showcase-demo-2026`, name "Alex Rivera".

The story is a busy week for a startup founder: launching "Kestrel 2.0", booking flights to a conference in Lisbon, triaging email and fixing a bug in a side project.
Every date is relative to the moment you seed, so labels like "2h ago" always read naturally.

## 1. Seed the database

```bash
pnpm --filter @open-bot/showcase seed
```

This drops and recreates `openbot_showcase`, runs the Drizzle migrations against it, and inserts everything.
It refuses to run against any database that is not named `openbot_showcase`.
It is idempotent: running it again resets to the same state (with fresh timestamps).
It needs Postgres up (`pnpm infra:up`) and Playwright's Chromium, which it uses to render the fake screenshots and page thumbnails.
Every insert is typed against the Drizzle schema, so `pnpm typecheck` fails when a schema change breaks the seed, and CI seeds a fresh database on every pull request.

The owner account is inserted directly, with the password hashed by better-auth's own `hashPassword`.
That needs no running server, and the real login form accepts it.

Reseeding invalidates old sessions, so run step 3 again afterwards.
A running showcase server logs a few database errors while the database is dropped and migrated, and recovers by itself.

## 2. Start the servers (without disturbing :3000)

```bash
# Pages service, for page previews (port 3401, showcase database)
cd apps/pages && PORT=3401 PAGES_URL=http://127.0.0.1:3401 APP_URL=http://localhost:3200 \
  DATABASE_URL=postgres://openbot:openbot@127.0.0.1:54329/openbot_showcase \
  nohup pnpm exec tsx --env-file-if-exists=../../.env src/index.ts > /tmp/pages-showcase.log 2>&1 &

# Web app (port 3200)
cd apps/web && TZ=America/Los_Angeles PAGES_URL=http://127.0.0.1:3401 \
  DATABASE_URL=postgres://openbot:openbot@127.0.0.1:54329/openbot_showcase \
  OPENBOT_NEXT_DIST_DIR=.next-showcase BETTER_AUTH_URL=http://localhost:3200 \
  OWNER_EMAIL=alex@showcase.local \
  nohup pnpm exec next dev --port 3200 > /tmp/web-showcase.log 2>&1 &
```

What each variable is for:

- `DATABASE_URL` points the app at the showcase database. Replace `openbot:openbot@127.0.0.1:54329` if your `.env` differs.
- `OPENBOT_NEXT_DIST_DIR=.next-showcase` keeps this server's build output and lock away from the :3000 server.
- `BETTER_AUTH_URL=http://localhost:3200` makes sign-in work on this port. It sets the auth base URL and the trusted origin.
- `OWNER_EMAIL=alex@showcase.local` is required, because only the owner's email may sign in.
- `TZ=America/Los_Angeles` makes the server render times in the same zone as the screenshots, which avoids hydration warnings.
- `PAGES_URL` sends page links to the showcase pages service instead of the one on :3400, which has your real pages.

Process environment wins over the `.env` files, so everything else (secrets, encryption key) comes from your normal `.env`.

`next dev` adds the type folders of any output folder missing from `apps/web/tsconfig.json`'s `include`, and rewrites the file to do it.
`.next-showcase` is already listed there, so the file stays untouched; a new `OPENBOT_NEXT_DIST_DIR` needs its two entries added the same way.

## 3. Sign in and save a Playwright storage state

```bash
node tools/showcase/auth.mjs            # writes /tmp/ui/showcase-auth.json
```

This signs in through the real form at `http://localhost:3200/login`.
The state also holds the "last active" marks in localStorage, set to ten hours ago, so Home shows its "While you were away" briefing.

Use the state in your own scripts like this:

```js
const context = await browser.newContext({
  baseURL: "http://localhost:3200",
  storageState: "/tmp/ui/showcase-auth.json",
  timezoneId: "America/Los_Angeles", // the story is told in Pacific time
  locale: "en-US",
  viewport: { width: 1440, height: 900 },
});
```

## 4. Screenshot every page

```bash
node tools/showcase/shoot.mjs /tmp/ui/showcase            # light
node tools/showcase/shoot.mjs /tmp/ui/showcase --dark     # dark
node tools/showcase/shoot.mjs /tmp/ui/showcase --only=home,tasks
```

This visits Home, Approvals, Tasks, Automations, Skills, Pages (and a page viewer), Vault, Files, Computer, Settings, every teammate and the main chats.
It prints console errors and 5xx responses for each page.

## What is seeded

| Feature       | Data                                                                                                                                                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Teammates     | Iris (chief of staff, lead), Scout (research), Kit (software engineer), Mira (email), Juno (writer). Distinct colors, emoji, long instructions, autonomy levels, budgets for Iris and Kit.                                              |
| Chats         | 9 direct chats, 2 group chats (Launch war room, Lisbon trip), a Scheduled chat for 4 teammates, Mira's Email inbox chat, and 3 swarm helper chats.                                                                                      |
| Runs          | Markdown replies with lists, tables, a code block, a quote and links. Commands (with output, one failing), file changes with diffs, web searches, plans, tool calls, handoffs, a swarm, page cards, desktop screenshots, errors.        |
| Live states   | Scout working, Iris and Mira waiting for approval, Juno waiting for you to take over, Kit idle.                                                                                                                                         |
| Approvals     | 2 pending (a $842.30 flight purchase, an email to the Summit organizer with preview), approved and denied commands and one approved push.                                                                                               |
| Tasks         | 5 to do, 5 doing, 7 done, with owners, due dates, notes and links to chats.                                                                                                                                                             |
| Automations   | 6 schedules (daily, weekly, once, quiet, paused), a page watch, a webhook, a Gmail trigger, a Calendar trigger, past runs including a failed one and "nothing to report" ones.                                                          |
| Skills        | 3 shared and 3 teammate-specific.                                                                                                                                                                                                       |
| Pages         | 4 pages (2 pinned), up to 3 versions each, with light and dark thumbnails.                                                                                                                                                              |
| Vault         | 5 logins and 2 cards (fake values, sealed with your ENCRYPTION_KEY), 5 purchases across statuses.                                                                                                                                       |
| Memory        | 8 confirmed shared memories (2 pinned, 1 expiring), 2 suggestions waiting to be confirmed, 6 per-teammate memories, 7 lessons (also shown on teammate pages), revision history, an "about you" profile, 1 pending instruction proposal. |
| Briefing      | 6 runs finished and 1 failed in the last ten hours.                                                                                                                                                                                     |
| Notifications | 10, six unread, covering approvals, takeover, failure, messages, finished runs and a page.                                                                                                                                              |
| Usage         | Per-run token usage, 36 extra entries through the month, an API key hint and spend against the $20 cap.                                                                                                                                 |
| Connections   | Google (Gmail, Calendar) and Notion accounts, 3 MCP servers (GitHub, Linear, a Postgres reader). Tokens are fake.                                                                                                                       |
| Email         | Domain `kestrel.team`, 3 emails in Mira's inbox.                                                                                                                                                                                        |

## What cannot be seeded

These need the worker or the computer container, which the showcase does not start:

- Computer and Files pages show "The worker isn't running", and `/api/files/list` answers 503.
- Settings: the Telegram and push sections call the worker and answer 503, so the Next.js dev overlay shows a red issue badge at the bottom left.
- Live desktop streams in the screen panel. Screenshots in runs are rendered by `assets.mjs` and are mock pages, not real browsing.
- Anything that changes over time without the worker, such as the running Scout run, which stays "Working" and counts up.
