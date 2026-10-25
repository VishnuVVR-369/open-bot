# open-bot

Your AI teammates and the computer they share.

open-bot is a personal, open-source take on Grok Bot.
You create teammates with jobs, and they do real work on one persistent cloud computer: a Linux desktop with a browser, a shell and files.
You watch them work live, take over the computer at any moment, and hand it back with a note.

## What it does

- **Teammates with jobs.** Each bot has a name, a job, instructions, its own versioned memory and a rule for when to ask you first.
- **One shared computer.** XFCE, Chromium, a shell and a filesystem, with logged-in browser sessions shared by every bot.
- **A screen per teammate.** Every bot gets its own screen on the computer, so several can browse at once, and a sign-in on one screen works on all of them.
- **Live screens and takeover.** Screens stream into the app. Press Take over and that bot stops using its screen until you hand it back.
- **Bots ask for you.** For passwords, 2FA and CAPTCHAs a bot asks you to take over, then continues from your note.
- **Approvals.** Sending, publishing, buying and deleting wait for your decision, inline and in the Approvals inbox. "Always allow" stops a bot asking about the same thing again.
- **Skills.** Save the steps for a task once and run it with `/name` in any chat. Bots save skills too.
- **Automations.** Routines and reminders on a schedule, page watches that wake a teammate when a page changes ("tell me when it's back in stock"), and webhooks that let other services start one. You or the bots set them up, they run while your laptop is closed, and you see how each run went.
- **About you.** Shared facts and preferences every teammate can recall, with source history, revisions, expiry, and control over what is remembered.
- **Memory you control.** Add, search, correct, pin, export, restore or forget facts and lessons. Bots recall relevant memory before each task; inferred facts wait for confirmation. Optional semantic search and extraction use your own endpoints. See [memory setup and architecture](docs/memory.md).
- **Teach them.** Thumbs down a reply, say what to change, and the teammate tries again and keeps the lesson for every future task.
- **While you were away.** Come back to Home and see what each teammate finished or got stuck on.
- **Templates.** Start a chief of staff, researcher, inbox helper and more, with starter automations like a weekday morning briefing.
- **Telegram.** Approve with a button, get told when a teammate needs you, and message your teammates from your phone.
- **Group chats with handoffs.** Put teammates in one room; the lead answers and hands work to whoever's job fits.
- **A team that works together.** Teammates ask each other questions from any chat, and share a task board with you: give a task to a teammate and ask them to start, or hand a goal to your chief of staff to split up.
- **They get better.** A teammate can suggest a rewrite of its own instructions, and every template reviews its week on Friday; you see the change as a diff and decide.
- **A vault and a budget.** Save logins and cards; teammates fill them in on the computer without ever reading them, a login only on its own site. Each teammate pays only within a monthly budget you set, and larger purchases ask you first.
- **Check-ins that only speak up for news.** Every template checks in each morning and stays quiet when there's nothing; any schedule can be set to "only tell me when there's news".
- **Swarms.** A teammate splits a big job, like comparing many shops, across helpers that work at the same time on screens of their own, and merges their results. You can watch each helper live.
- **Connections.** Give teammates services like GitHub, Notion or your own API through MCP, so they use the service's tools instead of its website.
- **Job Scout.** A template that collects the jobs LinkedIn and Naukri recommend to your signed-in accounts into [application-tracker](docs/job-scout-plan.md), which scores them against your resumes and prepares suggested edits. It only reads; the browser itself blocks job applications unless you're the one at the screen.
- **Reads pages as text.** Teammates read long pages (articles, listings, job descriptions) as text and links instead of from screenshots.
- **Email.** Every teammate gets an address on your domain through Postmark. Emails start them in their Email chat, and what they write waits for your approval, then sends by itself.
- **Steer and stop.** Message a bot while it works to add to its task, or stop it.
- **Search everything.** ⌘K jumps to any teammate, chat or page, and searches every message and reply.
- **Duplicate, export and import.** Start a new bot from one that already works the way you like, or share it as a file.
- **Files.** Browse, upload, download and delete what's on the computer, and attach files of up to 40 MB to a message. Files mentioned in replies open in the app: images, PDFs, Markdown, tables and text.
- **Replay.** Watch what a teammate did on its screen, frame by frame.
- **Voice.** Speak a message instead of typing it, and have replies read aloud.
- **Push notifications.** Install open-bot on your phone or computer and get approvals and replies even when it's closed.
- **When your plan runs out.** Teammates switch to your OpenAI API key until the plan resets, up to a monthly cap you set.
- **Desktop app.** Native notifications, a menu bar icon, and browsing through your home connection so websites don't see a cloud IP.

## How it fits together

```
Web app (Next.js) ──► Postgres ◄── Worker ──► botd (in the computer container)
       ▲                              │            ├─ codex app-server  (the agent)
       │                              │            ├─ XFCE + Chromium   (the desktop)
Desktop app (Electron) ── egress ─────┘            └─ x11vnc            (the live view)
```

- `apps/web`: the app, auth (Better Auth, locked to one email), server actions and a realtime event stream.
- `apps/worker`: runs bot turns through the Codex app-server, serves the bots' tools, schedules, approvals, takeovers, the VNC proxy and the egress relay.
- `apps/botd`: the daemon inside the computer: process supervision, the desktop lease, desktop actions and the bridges.
- `apps/desktop`: the Electron app and its egress agent.
- `packages/*`: database schema, the typed Codex client, the egress tunnel and shared types.
- `images/computer`: the computer's Docker image.

The design and its reasons are in [docs/architecture.md](docs/architecture.md).

## Run it locally

You need Node 24, pnpm 10, Docker, and the Codex CLI signed in to ChatGPT on this Mac (`codex login`).

```sh
pnpm install
cp .env.example .env            # set OWNER_EMAIL to your email
pnpm infra:up                   # Postgres and the computer (the first build takes a few minutes)
pnpm db:migrate
pnpm dev                        # web on http://localhost:3000, worker on :4001
```

Open http://localhost:3000, create your account, and create your first teammate.
In development the computer borrows this Mac's Codex login, read-only; Settings can switch it to its own ChatGPT login.

Desktop app:

```sh
pnpm --filter @open-bot/desktop dev
```

## Tests

```sh
pnpm lint && pnpm typecheck && pnpm test         # static checks and unit tests
pnpm test:memory -- --e2e                       # isolated memory database and browser tests
E2E_EMAIL=you@example.com E2E_PASSWORD=... pnpm e2e --grep-invert @agent   # fast end-to-end tests
E2E_EMAIL=you@example.com E2E_PASSWORD=... pnpm e2e --grep @agent          # real bots at work (slow, uses your plan)
```

The end-to-end tests run against the local stack, so start it first.

To run the Job Scout against a real Application tracker (a test user's token, issued with `npx convex run apiTokens:issue` in the tracker), set its MCP address and token:

```sh
E2E_TRACKER_MCP_URL=https://<deployment>.convex.site/mcp E2E_TRACKER_TOKEN=at_... E2E_EMAIL=you@example.com E2E_PASSWORD=... pnpm e2e --grep "real Application tracker"
```

To test Telegram without a real bot, start the worker pointed at the tests' stand-in for the Bot API, then run the Telegram tests:

```sh
TELEGRAM_API_BASE_URL=http://127.0.0.1:4797 pnpm --filter @open-bot/worker dev
E2E_TELEGRAM=1 E2E_EMAIL=you@example.com E2E_PASSWORD=... pnpm e2e --grep Telegram
```

To rehearse the plan running out (the fallback to your API key) without exhausting your plan, start the worker with the plan and API endpoints pointed at the test's mock server, then run the rehearsal:

```sh
OPEN_BOT_PLAN_BASE_URL=http://host.docker.internal:4799/plan OPENAI_API_BASE_URL=http://host.docker.internal:4799/api pnpm --filter @open-bot/worker dev
E2E_PLAN_REHEARSAL=1 E2E_EMAIL=you@example.com E2E_PASSWORD=... pnpm e2e --grep rehearsal
```
