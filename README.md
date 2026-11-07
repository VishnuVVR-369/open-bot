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
- Ask a teammate, like a chief of staff, to build your team: it creates teammates with their instructions, skills and routines, and you approve each one.
- Copy a teammate you like, or export it to a file and share it.

### Watch and take over

- Every teammate gets its own screen, so several can work at once.
- Watch any screen live in the app, or replay what a teammate did.
- Press **Take over** to use the computer yourself, then hand it back with a note.
- When a teammate hits a password, 2FA code or CAPTCHA, it asks you to take over.

### Stay in control

- Sending, publishing, buying and deleting wait for your approval.
- Even a teammate that works on its own asks before a dangerous command, like deleting files, and asks only once for something you just approved.
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
- Wake a teammate when new mail arrives in your Gmail, like "file every receipt", or before events on your calendar, like "brief me 30 minutes before meetings".
- Check-ins stay quiet when there is nothing new.
- Automations keep running when your laptop is closed.

### Teamwork

- Put teammates in a group chat. The lead answers and hands work to the right teammate.
- Teammates can ask each other questions.
- Share a task board with your teammates.
- Split a big job across helpers that work at the same time, then combine the results.

### Pages

- Ask a teammate for a page, and it builds a polished HTML page you open in the app: an in-depth explainer, a research report, a comparison, a dashboard, an itinerary or a study guide.
- Share a link to a post about a system design, and get back a page that explains it in depth, with diagrams, the life of a request, the trade-offs and the sources.
- Every page is checked in a browser on the computer before it is published, at a phone's width and a laptop's.
- Changing a page adds a new version, and you can switch between versions.
- Select any passage and choose **Ask about this** to ask the teammate about it, or ask for a change.
- Pages are private to you, and open on the web and on your phone.
- Run with `/page` in any chat, or keep a page current with a schedule.

### Tools and connections

- **Skills:** save the steps for a task once, then run it with `/name` in any chat.
- **Your accounts:** connect Gmail, Google Calendar and Notion. Teammates search your mail, draft replies, plan events and write pages, and anything other people would see asks you first.
- **Connections:** give teammates access to GitHub or your own API through MCP.
- **Email:** each teammate gets an email address on your domain through Postmark.
- **Telegram:** approve actions, get alerts and chat with teammates from your phone.
- **Files:** browse, upload and download files on the computer, and attach files up to 40 MB.
- **Voice:** speak your messages and hear replies read aloud.
- **Search:** press ⌘K to find any teammate, chat, page or message.

### Apps and notifications

- Come back to **Home** to see what each teammate finished or got stuck on.
- Install open-bot on your phone or computer to get push notifications.
- The [Android app](apps/mobile/README.md) brings Home, chats, attachments, search, approval decisions and live computer takeover to your phone, with inline replies and one-time-code entry from notifications.
- The desktop app adds native notifications, a menu bar icon, and browsing through your home internet so websites don't see a cloud IP.
- If your ChatGPT plan runs out, teammates switch to your OpenAI API key, up to a monthly limit you set.

## How it works

```
         Pages service (its own origin, shows published pages)
                         │
                         ▼
Web app (Next.js) ──► Postgres ◄── Worker ──► botd (in the computer container)
       ▲                              │            ├─ codex app-server  (the agent)
       │                              │            ├─ XFCE + Chromium   (the desktop)
Desktop app (Electron) ── egress ─────┘            └─ x11vnc            (the live view)
```

- `apps/web`: the web app you use.
- `apps/worker`: runs the teammates, their tools, schedules and approvals.
- `apps/botd`: a helper that runs inside the computer and controls the desktop.
- `apps/pages`: a small server that shows published pages, on an origin of its own so a page never runs with your session.
- `apps/desktop`: the desktop app.
- `apps/site`: the public landing page with the launch tour, and the technical documentation under `/docs`.
- `packages/*`: shared code like the database schema and types.
- `packages/page-kit`: the styles, scripts and libraries pages load from `/lib`, and the `/page` skill teammates follow.
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
pnpm dev                        # web on http://localhost:3000, worker on :4001, pages on :3400
```

Open http://localhost:3000, create your account, and create your first teammate.

In development, the computer uses your Mac's Codex login in read-only mode.
You can switch it to its own ChatGPT login in Settings.

To run the desktop app:

```sh
pnpm --filter @open-bot/desktop dev
```

## Passwords

open-bot has one account, the owner's, and sends no email, so there is no reset link.
Change your password in Settings, under Security; you need the current one.

If you forget it and have a passkey, choose "Forgot password?" on the sign-in page, then "Sign in with a passkey".
You land on the form for a new password, and you don't need the old one.
This works for 10 minutes after a passkey sign-in where the device checked it's you (Touch ID, a PIN), and only in that same session.
Setting the password signs out every other device.
Already signed in? Under Security, choose "Use your passkey instead" and confirm with the passkey when you save.

Without a passkey, reset it from the server.
In a terminal in the open-bot folder, with the same environment the app runs with (`.env` locally, or a shell on the web service in the cloud, like `railway ssh --service web`):

```sh
pnpm owner:reset-password you@example.com
```

The email must be `OWNER_EMAIL`, or nothing changes.
It asks for the new password twice, saves it with the same hashing sign-in uses, and signs out every device.
Passkeys keep working.

## Tests

```sh
pnpm verify                                     # lint, doc paths, typecheck, unit and integration tests (needs Docker)
E2E_EMAIL=you@example.com E2E_PASSWORD=... pnpm e2e --grep-invert @agent   # end-to-end tests against the running stack
```

The full list of suites, what each needs, the stand-ins for outside services and how to run them is in the Development docs: `apps/site/src/app/docs/development/page.mdx` (`/docs/development` on the site).
