# open-bot

AI teammates that do real work on their own computer.

open-bot is similar to Grok Bot, OpenAI Dots and Meta Muse.
It is personal and open source.

You create teammates and give each one a job.
They work on a shared cloud computer that has a Linux desktop, a browser, a shell and files.
You can watch them work live, take over the computer at any time, and hand it back when you are done.

## What you can do

### Create teammates

- Give each teammate a name, a job and instructions.
- Start fast from templates like a chief of staff, a researcher or an inbox helper.
- Copy a teammate you like, or export it to a file and share it.

### Watch and take over

- Every teammate gets its own screen, so several can work at once.
- Watch any screen live in the app, or replay what a teammate did.
- Press **Take over** to use the computer yourself, then hand it back with a note.
- When a teammate hits a password, 2FA code or CAPTCHA, it asks you to take over.

### Stay in control

- Sending, publishing, buying and deleting wait for your approval.
- Choose **Always allow** so a teammate stops asking about the same thing.
- Save logins and cards in a vault. Teammates can use them but never see them.
- Set a monthly budget for each teammate. Bigger purchases ask you first.
- Message a teammate while it works to change its task, or stop it.

### Memory and learning

- Teammates remember facts about you and lessons from past work.
- You can see, search, fix, pin, export or delete anything they remember.
- Give a reply a thumbs down and say what to change. The teammate tries again and remembers the lesson.
- Teammates can suggest better instructions for themselves. You review the change and decide.

### Automations

- Run tasks on a schedule, like a morning briefing every weekday.
- Watch a page and wake a teammate when it changes, like "tell me when it's back in stock".
- Start a teammate from another service with a webhook.
- Check-ins stay quiet when there is nothing new.
- Automations keep running when your laptop is closed.

### Teamwork

- Put teammates in a group chat. The lead answers and hands work to the right teammate.
- Teammates can ask each other questions.
- Share a task board with your teammates.
- Split a big job across helpers that work at the same time, then combine the results.

### Tools and connections

- **Skills:** save the steps for a task once, then run it with `/name` in any chat.
- **Connections:** give teammates access to GitHub, Notion or your own API through MCP.
- **Email:** each teammate gets an email address on your domain through Postmark.
- **Telegram:** approve actions, get alerts and chat with teammates from your phone.
- **Files:** browse, upload and download files on the computer, and attach files up to 40 MB.
- **Voice:** speak your messages and hear replies read aloud.
- **Search:** press ⌘K to find any teammate, chat or message.

### Apps and notifications

- Come back to **Home** to see what each teammate finished or got stuck on.
- Install open-bot on your phone or computer to get push notifications.
- The desktop app adds native notifications, a menu bar icon, and browsing through your home internet so websites don't see a cloud IP.
- If your ChatGPT plan runs out, teammates switch to your OpenAI API key, up to a monthly limit you set.

## How it works

```
Web app (Next.js) ──► Postgres ◄── Worker ──► botd (in the computer container)
       ▲                              │            ├─ codex app-server  (the agent)
       │                              │            ├─ XFCE + Chromium   (the desktop)
Desktop app (Electron) ── egress ─────┘            └─ x11vnc            (the live view)
```

- `apps/web`: the web app you use.
- `apps/worker`: runs the teammates, their tools, schedules and approvals.
- `apps/botd`: a helper that runs inside the computer and controls the desktop.
- `apps/desktop`: the desktop app.
- `packages/*`: shared code like the database schema and types.
- `images/computer`: the Docker image for the computer.

## Run it locally

You need:

- Node 24
- pnpm 10
- Docker
- The Codex CLI, signed in to ChatGPT (`codex login`)

Then run:

```sh
pnpm install
cp .env.example .env            # set OWNER_EMAIL to your email
pnpm infra:up                   # starts Postgres and the computer (first build takes a few minutes)
pnpm db:migrate
pnpm dev                        # web on http://localhost:3000, worker on :4001
```

Open http://localhost:3000, create your account, and create your first teammate.

In development, the computer uses your Mac's Codex login in read-only mode.
You can switch it to its own ChatGPT login in Settings.

To run the desktop app:

```sh
pnpm --filter @open-bot/desktop dev
```

## Tests

Start the local stack first, then run:

```sh
pnpm lint && pnpm typecheck && pnpm test         # checks and unit tests
pnpm test:memory -- --e2e                       # memory database and browser tests
E2E_EMAIL=you@example.com E2E_PASSWORD=... pnpm e2e --grep-invert @agent   # fast end-to-end tests
E2E_EMAIL=you@example.com E2E_PASSWORD=... pnpm e2e --grep @agent          # real teammates at work (slow, uses your plan)
```

### Telegram tests

These use a fake Telegram server, so you don't need a real bot:

```sh
TELEGRAM_API_BASE_URL=http://127.0.0.1:4797 pnpm --filter @open-bot/worker dev
E2E_TELEGRAM=1 E2E_EMAIL=you@example.com E2E_PASSWORD=... pnpm e2e --grep Telegram
```

### Plan fallback tests

These pretend your plan ran out, so you can test the switch to your API key without using up your plan:

```sh
OPEN_BOT_PLAN_BASE_URL=http://host.docker.internal:4799/plan OPENAI_API_BASE_URL=http://host.docker.internal:4799/api pnpm --filter @open-bot/worker dev
E2E_PLAN_REHEARSAL=1 E2E_EMAIL=you@example.com E2E_PASSWORD=... pnpm e2e --grep rehearsal
```
