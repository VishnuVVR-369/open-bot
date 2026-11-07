// Everything around the conversations: automations, accounts, tasks, skills, vault, memory,
// notifications, pages, usage and settings.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { InferInsertModel } from "drizzle-orm";
import {
  accounts,
  connections,
  credentials,
  emails,
  instructionProposals,
  lessons,
  memoryImports,
  memoryItems,
  memoryRevisions,
  nativePushDevices,
  notifications,
  oauthClients,
  pageVersions,
  pages,
  purchases,
  schedules,
  skills,
  tasks,
  triggers,
  usageEntries,
  vaultItems,
} from "@open-bot/db";
import {
  ago,
  fmtDay,
  fromNow,
  isoDay,
  lastOccurrences,
  memoryFingerprint,
  nextOccurrence,
  plus,
  seal,
  TIMEZONE,
  type SeedContext,
  type RowWithDefaults,
} from "./lib";

const WEEKDAYS = [1, 2, 3, 4, 5];

/* ------------------------------------------------------------------ Accounts and connections */

export async function seedConnections(ctx: SeedContext) {
  const { db, encryptionKey, bots } = ctx;
  const { iris, kit, mira, scout } = bots;
  ctx.conn = {};

  const googleClient = randomUUID();
  await db.insert(oauthClients, {
    id: googleClient,
    provider: "google",
    source: "owner",
    clientId: "showcase-412908.apps.googleusercontent.com",
    encryptedSecret: seal("GOCSPX-showcase-not-a-real-secret", encryptionKey),
    hint: "showcase-4129…",
    createdAt: ago({ d: 20 }),
  });
  const notionClient = randomUUID();
  await db.insert(oauthClients, {
    id: notionClient,
    provider: "notion",
    source: "registered",
    clientId: "notion-showcase-client",
    issuer: "https://mcp.notion.com",
    redirectUri: "http://localhost:3200/api/accounts/callback",
    createdAt: ago({ d: 19 }),
  });

  const tokens = (access) =>
    seal(
      JSON.stringify({
        accessToken: access,
        refreshToken: `${access}-refresh`,
        expiresAt: fromNow({ h: 1 }).getTime(),
        tokenType: "Bearer",
      }),
      encryptionKey,
    );
  const googleAccount = randomUUID();
  await db.insert(accounts, {
    id: googleAccount,
    provider: "google",
    externalId: "109834571290348172345",
    oauthClientId: googleClient,
    display: "alex@kestrel.team",
    scopes: [
      "openid",
      "email",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.events",
    ],
    encrypted: tokens("ya29.showcase"),
    status: "connected",
    grantedAt: ago({ d: 20 }),
    lastRefreshedAt: ago({ m: 40 }),
    lastUsedAt: ago({ m: 70 }),
    createdAt: ago({ d: 20 }),
  });
  const notionAccount = randomUUID();
  await db.insert(accounts, {
    id: notionAccount,
    provider: "notion",
    externalId: "ws_91ab3c:user_4d2e7f",
    oauthClientId: notionClient,
    display: "Kestrel HQ",
    scopes: [],
    encrypted: tokens("ntn_showcase"),
    status: "connected",
    grantedAt: ago({ d: 18 }),
    lastUsedAt: ago({ d: 2 }),
    createdAt: ago({ d: 18 }),
  });

  const accountConnection = async (
    row: RowWithDefaults<
      typeof connections,
      | "id"
      | "transport"
      | "args"
      | "secretNames"
      | "enabled"
      | "askBeforeActing"
      | "settings"
      | "createdAt"
      | "updatedAt"
    >,
  ) => {
    const id = randomUUID();
    await db.insert(connections, {
      id,
      transport: null,
      args: [],
      secretNames: [],
      enabled: true,
      askBeforeActing: true,
      settings: {},
      createdAt: ago({ d: 20 }),
      updatedAt: ago({ d: 5 }),
      ...row,
    });
    return id;
  };
  ctx.conn.gmail = await accountConnection({
    label: "Gmail",
    name: "gmail",
    kind: "gmail",
    accountId: googleAccount,
    capabilities: ["read", "compose"],
    botIds: [mira.id, iris.id],
  });
  ctx.conn.calendar = await accountConnection({
    label: "Google Calendar",
    name: "google_calendar",
    kind: "google_calendar",
    accountId: googleAccount,
    capabilities: ["read", "write"],
    botIds: null,
  });
  await accountConnection({
    label: "Notion",
    name: "notion",
    kind: "notion",
    accountId: notionAccount,
    capabilities: ["read", "write"],
    botIds: null,
    askBeforeActing: false,
    settings: {
      area: {
        id: "1a2b3c4d5e6f4a7b8c9d0e1f2a3b4c5d",
        title: "Teammates",
        url: "https://www.notion.so/kestrel/Teammates-1a2b3c4d5e6f4a7b8c9d0e1f2a3b4c5d",
      },
    },
  });

  const mcp = async (row) =>
    db.insert(connections, {
      id: randomUUID(),
      kind: "mcp",
      enabled: true,
      createdAt: ago({ d: 25 }),
      updatedAt: ago({ d: 10 }),
      ...row,
    });
  await mcp({
    label: "GitHub",
    name: "github",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    encrypted: seal(
      JSON.stringify({ headers: { Authorization: "Bearer ghp_showcase" }, env: {} }),
      encryptionKey,
    ),
    secretNames: ["Authorization"],
    botIds: [kit.id, iris.id],
  });
  await mcp({
    label: "Linear",
    name: "linear",
    transport: "http",
    url: "https://mcp.linear.app/mcp",
    encrypted: seal(
      JSON.stringify({ headers: { Authorization: "Bearer lin_showcase" }, env: {} }),
      encryptionKey,
    ),
    secretNames: ["Authorization"],
    botIds: null,
  });
  await mcp({
    label: "Kestrel analytics (read-only)",
    name: "kestrel-db",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres"],
    encrypted: seal(
      JSON.stringify({
        headers: {},
        env: { DATABASE_URL: "postgres://readonly@db.internal/kestrel" },
      }),
      encryptionKey,
    ),
    secretNames: ["DATABASE_URL"],
    botIds: [scout.id, kit.id],
  });
}

/* ------------------------------------------------------------------ Schedules, triggers, quiet runs */

const BRIEFINGS = [
  (day) => `**${day}.** Three things on your plate.

- **11:00** Brightpath check-in with Marcus (30 min). Bring the retention chart.
- **14:00** 1:1 with Dana. Open item: the on-call rota for launch week.
- **Due today:** reply to Sam Whitaker's quote request (Mira has a draft).

Nothing urgent overnight. Kit's rollback run finishes this afternoon.`,
  (day) => `**${day}.** A light morning and a heavy afternoon.

- **9:00 to 11:00** is clear for deep work.
- **13:30** Press call with The Weekly Stack, 20 min.
- **16:00** Launch review with Juno and Kit.

Two decisions waiting for you: the embargo time for press, and whether to hold the launch date. Both are in the Launch plan chat.`,
  (day) => `**${day}.** Four meetings, two tasks due.

- **10:00** Product sync (Dana, Mateo).
- **12:30** Lunch with Priya from the Summit, optional.
- **15:00** Investor update review with Mira.
- **Due:** MRR and churn numbers for the update, review the launch post.

Mira flagged an invoice from Northhost: $212.40, same as last month.`,
];

async function scheduledRuns(
  ctx: SeedContext,
  chat,
  bot,
  schedule,
  texts,
  occurrences,
  extra = {},
) {
  const { s } = ctx;
  const runs = [];
  for (const [index, at] of occurrences.entries()) {
    const spec = texts[index % texts.length];
    const result = typeof spec === "function" ? spec(fmtDay(at)) : spec;
    runs.push(
      await s.run(chat, bot, {
        at,
        trigger: "schedule",
        scheduleId: schedule.id,
        prompt: `[Scheduled task: "${schedule.title}"]\n\n${schedule.prompt}`,
        ...(typeof result === "object"
          ? result
          : { items: [{ kind: "message", text: result, phase: "final", dur: 4000 }] }),
        ...extra,
      }),
    );
  }
  return runs;
}

export async function seedAutomations(ctx: SeedContext) {
  const { db, s, bots } = ctx;
  const { iris, scout, kit, mira, juno } = bots;
  const msgItem = (text) => ({ kind: "message", text, phase: "final", dur: 4000 });
  const toolItem = (name, label, result) => ({
    kind: "tool",
    name,
    label,
    args: {},
    result,
    dur: 1400,
  });

  const chatFor = (bot, kind, title) =>
    s.chat({ kind, title, titled: false, bot, createdAt: ago({ d: 16 }) });
  const irisSched = await chatFor(iris, "scheduled", "Scheduled");
  const miraSched = await chatFor(mira, "scheduled", "Scheduled");
  const scoutSched = await chatFor(scout, "scheduled", "Scheduled");
  const kitSched = await chatFor(kit, "scheduled", "Scheduled");
  ctx.chats.kitSched = kitSched;
  const miraInbox = await chatFor(mira, "inbox", "Email");
  ctx.chats.miraInbox = miraInbox;

  const makeSchedule = async (
    bot,
    row: RowWithDefaults<
      typeof schedules,
      | "id"
      | "botId"
      | "kind"
      | "timezone"
      | "enabled"
      | "quiet"
      | "createdBy"
      | "nextRunAt"
      | "lastRunAt"
      | "createdAt"
    >,
    spec,
    extra: Partial<InferInsertModel<typeof schedules>> = {},
  ) => {
    const id = randomUUID();
    const occurrences = spec ? lastOccurrences(spec, 3) : [];
    await db.insert(schedules, {
      id,
      botId: bot.id,
      kind: "cron",
      timezone: TIMEZONE,
      enabled: true,
      quiet: false,
      createdBy: "user",
      nextRunAt: spec ? nextOccurrence(spec) : null,
      lastRunAt: occurrences.at(-1) ?? null,
      createdAt: ago({ d: 15 }),
      ...row,
      ...extra,
    });
    return { id, title: row.title, prompt: row.prompt, occurrences };
  };

  // Iris: morning briefing, weekdays at 8:00.
  const briefing = await makeSchedule(
    iris,
    {
      title: "Morning briefing",
      prompt:
        "Give me a morning briefing: today's calendar, tasks due today or overdue, and anything from the team that needs my decision. Keep it under 150 words.",
      cron: "0 8 * * 1-5",
    },
    { hour: 8, minute: 0, days: WEEKDAYS },
  );
  await scheduledRuns(ctx, irisSched, iris, briefing, BRIEFINGS, briefing.occurrences, {
    readOutsideData: true,
  });

  // Mira: inbox digest, quiet.
  const digest = await makeSchedule(
    mira,
    {
      title: "Morning inbox digest",
      prompt:
        "Check my inbox. Tell me about anything from investors, press or customers that needs a reply today. Skip newsletters and receipts.",
      cron: "30 7 * * 1-5",
      quiet: true,
    },
    { hour: 7, minute: 30, days: WEEKDAYS },
  );
  await scheduledRuns(
    ctx,
    miraSched,
    mira,
    digest,
    [
      `Two worth your attention.

1. **Marcus (Brightpath)** replied about Thursday. He can do 9:30.
2. **A journalist from The Weekly Stack** moved her deadline to Monday noon.`,
      "Nothing to report.",
      `One reply needed: **Sam Whitaker** wants two sentences on why privacy-first analytics matters now. I drafted three options.`,
    ],
    digest.occurrences,
    { readOutsideData: true },
  );

  // Scout: Friday notes.
  const friday = await makeSchedule(
    scout,
    {
      title: "Friday market notes",
      prompt:
        "Summarize what changed this week in web analytics: pricing moves, launches and funding news from the competitors we track. Five bullets at most.",
      cron: "0 16 * * 5",
    },
    { hour: 16, minute: 0, days: [5] },
  );
  await scheduledRuns(
    ctx,
    scoutSched,
    scout,
    friday,
    [
      `**This week in analytics**

- **Pinwheel Analytics** launched heatmaps on its $29 plan, aimed squarely at teams leaving session-replay tools.
- **Quillmetrics** announced a $12M Series A led by a European fund and said EU hosting is "coming soon".
- **Tallyfox** added an API but kept it on the Pro plan.
- Plausible-style tools keep winning on cookie banners: two public case studies this week.

Net: nobody shipped funnels plus EU hosting yet. That is still Kestrel 2.0's gap to own.`,
    ],
    friday.occurrences.slice(-2),
    {},
  );

  // Kit: dependency audit, quiet. One of them failed.
  const audit = await makeSchedule(
    kit,
    {
      title: "Dependency audit",
      prompt:
        "Run an audit on the kestrel and tidepool repos. Only tell me about advisories rated moderate or higher.",
      cron: "0 9 * * 1",
      quiet: true,
    },
    { hour: 9, minute: 0, days: [1] },
  );
  const auditOccurrences = audit.occurrences;
  if (auditOccurrences[0])
    await scheduledRuns(ctx, kitSched, kit, audit, ["Nothing to report."], [auditOccurrences[0]]);
  if (auditOccurrences[1])
    await scheduledRuns(
      ctx,
      kitSched,
      kit,
      audit,
      [
        {
          status: "failed",
          error: "The npm registry timed out after 60 seconds.",
          items: [
            {
              kind: "command",
              command: "/bin/bash -lc 'pnpm audit --audit-level moderate'",
              cwd: "/home/bot/bots/kit/kestrel",
              output:
                "ERR_PNPM_AUDIT_BAD_RESPONSE  The audit endpoint (at https://registry.npmjs.org/-/npm/v1/security/audits) responded with 504",
              exitCode: 1,
              durationMs: 60_000,
              dur: 60_400,
              failed: true,
            },
            { kind: "error", message: "The npm registry timed out after 60 seconds.", dur: 300 },
          ],
        },
      ],
      [auditOccurrences[1]],
    );
  if (auditOccurrences[2])
    await scheduledRuns(
      ctx,
      kitSched,
      kit,
      audit,
      [
        `Two moderate advisories, both in dev dependencies.

- \`vite\` 5.4.8: path traversal in the dev server. Fixed in 5.4.11.
- \`esbuild\` 0.21.2: same class of issue, fixed in 0.21.5.

Neither ships to production. I can open a PR bumping both if you want it.`,
      ],
      [auditOccurrences[2]],
    );

  // A one-off, and one that is off.
  await makeSchedule(
    iris,
    {
      title: "Submit the October expense report",
      prompt:
        "Remind me to submit the October expense report, and attach the Northhost invoice and the Summit ticket receipt.",
      kind: "once",
      cron: null,
      runAt: fromNow({ d: 1, h: 3 }),
      createdBy: "bot",
    },
    null,
    {
      nextRunAt: fromNow({ d: 1, h: 3 }),
      kind: "once",
      cron: null,
      runAt: fromNow({ d: 1, h: 3 }),
    },
  );
  await makeSchedule(
    juno,
    {
      title: "Weekly newsletter draft",
      prompt:
        "Draft this week's Kestrel newsletter from the changelog and the best three questions in the support inbox.",
      cron: "0 14 * * 5",
      enabled: false,
    },
    { hour: 14, minute: 0, days: [5] },
  );

  /* ------------------------------ triggers */
  const tallyfox = randomUUID();
  await db.insert(triggers, {
    id: tallyfox,
    botId: scout.id,
    kind: "watch",
    title: "Tallyfox pricing page",
    prompt:
      "The page changed. Tell me what changed in the prices or plans, and whether it affects how we position Kestrel 2.0.",
    url: "https://tallyfox.example.com/pricing",
    intervalMinutes: 1440,
    lookFor: "per month",
    snapshot: "Starter $9/mo  Pro $34/mo  Scale $89/mo",
    nextCheckAt: fromNow({ h: 21 }),
    lastCheckedAt: ago({ h: 3 }),
    lastFiredAt: ago({ d: 2 }),
    createdBy: "bot",
    createdAt: ago({ d: 6 }),
  });
  await s.run(scoutSched, scout, {
    at: ago({ d: 2, h: 1 }),
    trigger: "watch",
    triggerId: tallyfox,
    readOutsideData: true,
    prompt: `[Watch: "Tallyfox pricing page"]\n\nThe page changed. Tell me what changed in the prices or plans, and whether it affects how we position Kestrel 2.0.`,
    items: [
      toolItem("watch_page", "Compared the page with the last check", "2 changes"),
      msgItem(`**Tallyfox raised its Pro plan from $29 to $34 a month.** The Starter and Scale plans did not change, and the pageview limit on Pro is still 100k.

That widens the gap with Kestrel 2.0 at $25 for 200k pageviews. I would not change our positioning, but the pricing comparison page should be refreshed before launch. Want me to do that?`),
    ],
  });

  const release = randomUUID();
  const releaseToken = randomBytes(18).toString("base64url");
  await db.insert(triggers, {
    id: release,
    botId: kit.id,
    kind: "webhook",
    title: "Update the changelog for a new release",
    prompt:
      "A release was published. Update the changelog draft with it and tell me if anything unexpected is in it.",
    token: releaseToken,
    lastFiredAt: ago({ h: 6 }),
    createdBy: "user",
    createdAt: ago({ d: 11 }),
  });
  await s.run(kitSched, kit, {
    at: ago({ d: 1, h: 4 }),
    trigger: "webhook",
    triggerId: release,
    prompt: `[Webhook: "Update the changelog for a new release"]\n\nA release was published. Update the changelog draft with it and tell me if anything unexpected is in it.`,
    items: [
      toolItem("search_history", "Read the release notes for v2.0.0-rc.2", "12 changes"),
      msgItem(
        `Release **v2.0.0-rc.2** is in the changelog draft. Nothing unexpected: eleven fixes and one new endpoint (\`GET /v1/sites/:id/goals\`).`,
      ),
    ],
  });
  await s.run(kitSched, kit, {
    at: ago({ h: 6 }),
    trigger: "webhook",
    triggerId: release,
    status: "failed",
    error: "Interrupted when the computer restarted.",
    prompt: `[Webhook: "Update the changelog for a new release"]\n\nA release was published. Update the changelog draft with it and tell me if anything unexpected is in it.`,
    items: [{ kind: "error", message: "Interrupted when the computer restarted.", dur: 300 }],
  });

  const investorMail = randomUUID();
  await db.insert(triggers, {
    id: investorMail,
    botId: mira.id,
    kind: "gmail",
    title: "Investor mail",
    prompt:
      "Summarize the new email in two lines and tell me if it needs a reply today. Don't reply yourself.",
    connectionId: ctx.conn.gmail,
    query: "from:(brightpath.vc OR cedarfund.com) is:unread",
    cursor: "1884201",
    nextCheckAt: fromNow({ m: 3 }),
    lastCheckedAt: ago({ m: 2 }),
    lastFiredAt: ago({ d: 2, h: 3 }),
    createdBy: "user",
    createdAt: ago({ d: 14 }),
  });
  await s.run(miraSched, mira, {
    at: ago({ d: 2, h: 3 }),
    trigger: "gmail",
    triggerId: investorMail,
    readOutsideData: true,
    prompt: `[Gmail: "Investor mail"]\n\nSummarize the new email in two lines and tell me if it needs a reply today. Don't reply yourself.`,
    items: [
      toolItem("gmail.read_thread", "Read 'Quick catch-up before launch?'", "1 message"),
      msgItem(`**Marcus Lindqvist (Brightpath)** wants a 30 minute catch-up before launch, Wednesday or Thursday morning.

Needs a reply today. Both mornings are free on your calendar after 11.`),
    ],
  });

  const prep = randomUUID();
  await db.insert(triggers, {
    id: prep,
    botId: iris.id,
    kind: "calendar",
    title: "Prep before external meetings",
    prompt:
      "Prepare me: who I'm meeting, what we last discussed, and the one thing I should bring up.",
    connectionId: ctx.conn.calendar,
    query: "guests",
    leadMinutes: 30,
    nextCheckAt: fromNow({ m: 10 }),
    lastCheckedAt: ago({ m: 4 }),
    lastFiredAt: ago({ d: 1, h: 2 }),
    createdBy: "user",
    createdAt: ago({ d: 13 }),
  });
  await s.run(irisSched, iris, {
    at: ago({ d: 1, h: 2 }),
    trigger: "calendar",
    triggerId: prep,
    readOutsideData: true,
    prompt: `[Calendar: "Prep before external meetings"]\n\nPrepare me: who I'm meeting, what we last discussed, and the one thing I should bring up.`,
    items: [
      toolItem("calendar.get_event", "Read 'Brightpath check-in'", "3 guests"),
      toolItem("search_history", "Found the last two conversations with Marcus", "2 matches"),
      msgItem(`**In 30 minutes: Brightpath check-in** with Marcus Lindqvist and two partners.

- **Last time (Oct 14):** he asked about net revenue retention. You said 108% and promised the cohort chart.
- **Bring up:** the Kestrel 2.0 launch date and the EU hosting angle. Marcus invested partly on privacy.
- The retention chart is in the Notion workspace under Investor updates.`),
    ],
  });

  await db.insert(triggers, {
    id: randomUUID(),
    botId: juno.id,
    kind: "watch",
    title: "Style guide updates",
    prompt: "Tell me if the AP-style updates page adds a new entry that affects our posts.",
    url: "https://styles.example.org/ap-updates",
    intervalMinutes: 720,
    snapshot: "AP Style updates, 2026",
    nextCheckAt: fromNow({ h: 7 }),
    lastCheckedAt: ago({ h: 5 }),
    lastError: "The page returned 404 on the last check.",
    createdBy: "user",
    createdAt: ago({ d: 9 }),
  });

  /* ------------------------------ Mira's inbox */
  const mail = async ({
    at,
    direction = "in",
    status = undefined,
    from,
    to,
    subject,
    text,
    runId = null,
    replyToId = null,
  }: Partial<InferInsertModel<typeof emails>> & { at: Date }) => {
    const id = randomUUID();
    await db.insert(emails, {
      id,
      botId: mira.id,
      direction,
      status: status ?? (direction === "in" ? "received" : "sent"),
      chatId: miraInbox.id,
      from,
      to,
      subject,
      text,
      runId,
      replyToId,
      messageId: `<${randomBytes(8).toString("hex")}@showcase.local>`,
      createdAt: at,
    });
    return id;
  };

  const invoiceAt = ago({ d: 1, h: 3 });
  const invoiceRun = await s.run(miraInbox, mira, {
    at: invoiceAt,
    trigger: "email",
    prompt: "An email arrived from billing@northhost.example: Invoice INV-2291.",
    items: [
      {
        kind: "command",
        command:
          "/bin/bash -lc 'mkdir -p /home/bot/shared/invoices && cp /home/bot/shared/inbox/INV-2291.pdf /home/bot/shared/invoices/2026-11-northhost.pdf'",
        cwd: "/home/bot/bots/mira",
        output: "",
        exitCode: 0,
        durationMs: 120,
        dur: 520,
      },
      toolItem("add_task", "Added 'File Northhost invoice with expenses'", "To do"),
      msgItem(
        `Invoice **INV-2291 from Northhost, $212.40**, due in 14 days. Same amount as last month. I saved the PDF to \`shared/invoices/2026-11-northhost.pdf\` and added an expenses task for it.`,
      ),
    ],
  });
  await mail({
    at: invoiceAt,
    from: "billing@northhost.example",
    to: "mira@kestrel.team",
    subject: "Invoice INV-2291 for November",
    text: "Hello,\n\nYour invoice INV-2291 for November is attached. Amount due: $212.40. Payment is due within 14 days.\n\nThanks,\nNorthhost Billing",
    runId: invoiceRun.id,
  });

  const danaAt = ago({ h: 5, m: 10 });
  const danaRun = await s.run(miraInbox, mira, {
    at: danaAt,
    trigger: "email",
    readOutsideData: true,
    prompt: "An email arrived from dana@kestrel.team: Fwd: Refund request, annual plan.",
    items: [
      toolItem("list_emails", "Read the customer's earlier message", "2 messages"),
      msgItem(`Dana forwarded a refund request from a customer on the annual plan, 11 days after renewing. Your policy allows refunds within 14 days, so this qualifies.

I drafted a reply that apologizes briefly, confirms the refund of **$228**, and says when it will land. It is waiting in the email list for your OK, since it goes outside the company.`),
    ],
  });
  await mail({
    at: danaAt,
    from: "dana@kestrel.team",
    to: "mira@kestrel.team",
    subject: "Fwd: Refund request, annual plan",
    text: "Can you draft a reply for Alex? Customer renewed 11 days ago and wants out. Policy says yes. Original below.\n\n> Hi, I renewed by mistake and we moved to another tool. Could I get a refund?",
    runId: danaRun.id,
  });
  await mail({
    at: plus(danaAt, 90_000),
    direction: "out",
    status: "pending",
    from: "mira@kestrel.team",
    to: "customer@brightmill.example",
    subject: "Re: Refund request",
    text: "Hi,\n\nThanks for letting us know, and no problem at all. I have refunded your annual plan ($228). It should show up on your card within 5 to 7 business days.\n\nIf there is anything we could have done better, I would genuinely like to hear it.\n\nAlex",
    runId: danaRun.id,
  });
}

/* ------------------------------------------------------------------ Tasks, skills, vault, purchases */

export async function seedTasksAndSkills(ctx: SeedContext) {
  const { db, bots, chats } = ctx;
  const { iris, scout, kit, mira, juno } = bots;
  const { launch, freeze } = ctx.dates;
  const day = (n) => isoDay(fromNow({ d: n }));
  let position = 0;
  const task = (row) =>
    db.insert(tasks, {
      id: randomUUID(),
      notes: "",
      position: (position += 1),
      createdBy: "user",
      createdAt: ago({ d: 6 }),
      updatedAt: ago({ d: 1 }),
      ...row,
    });

  // To do
  await task({
    title: "Send MRR and churn numbers for the investor update",
    notes: "Mira drafts the update around them. Monthly numbers from Stripe are enough.",
    status: "todo",
    dueOn: day(2),
    createdByBotId: mira.id,
    createdBy: "bot",
  });
  await task({
    title: "Confirm the on-call rota for launch week",
    notes: "Dana covers launch night but not the morning after. Need a second name for 6 to 12.",
    status: "todo",
    ownerBotId: kit.id,
    dueOn: isoDay(new Date(freeze.getTime() - 86_400_000)),
    createdBy: "bot",
    createdByBotId: iris.id,
  });
  await task({
    title: "Write a two-minute demo script for the investor 1:1s",
    notes: "Funnels first, then EU hosting. Keep it under two minutes with no slides.",
    status: "todo",
    ownerBotId: juno.id,
    dueOn: isoDay(new Date(launch.getTime() + 6 * 86_400_000)),
  });
  await task({
    title: "Reply to the 3 press requests that asked for an embargo time",
    status: "todo",
    ownerBotId: mira.id,
    dueOn: day(3),
    createdBy: "bot",
    createdByBotId: iris.id,
  });
  await task({
    title: "File the Northhost invoice with expenses",
    status: "todo",
    ownerBotId: mira.id,
    createdBy: "bot",
    createdByBotId: mira.id,
  });
  // Doing
  await task({
    title: "Review the launch blog post (draft 3)",
    notes: "Juno added the upgrade FAQ. Check the tone of the intro and the migration answers.",
    status: "doing",
    dueOn: day(2),
    chatId: chats.junoPost.id,
  });
  await task({
    title: "Fix recurring reminders firing an hour late after DST",
    status: "doing",
    ownerBotId: kit.id,
    chatId: chats.kitBug.id,
  });
  await task({
    title: "Book the Lisbon flights and hotel",
    notes: "TAP nonstop at $842, then The Quiet Fig for four nights.",
    status: "doing",
    ownerBotId: iris.id,
    dueOn: day(3),
    chatId: chats.irisFlights.id,
  });
  await task({
    title: "Compile the changelog from merged PRs",
    status: "doing",
    ownerBotId: kit.id,
    dueOn: day(1),
    chatId: chats.war.id,
  });
  await task({
    title: "Line up the Summit schedule against the two investor 1:1s",
    status: "doing",
    ownerBotId: scout.id,
    chatId: chats.scoutFlights.id,
    createdBy: "bot",
    createdByBotId: iris.id,
  });
  // Done
  const done = (title, owner, daysAgo, extra = {}) =>
    task({
      title,
      status: "done",
      ownerBotId: owner?.id ?? null,
      completedAt: ago({ d: daysAgo }),
      createdAt: ago({ d: daysAgo + 5 }),
      updatedAt: ago({ d: daysAgo }),
      ...extra,
    });
  await done("Dry run the v1 to v2 migration on 40 workspaces", kit, 3);
  await done("Finalize the pricing page copy and plan names", juno, 4);
  await done("Summarize competitor pricing for the launch page", scout, 5);
  await done("Pick a hotel near the Summit venue", scout, 3);
  await done("Renew the kestrel.dev domain", iris, 8);
  await done("Set up the morning inbox digest", mira, 12);
  await done("Send the beta thank-you email to the 412 testers", null, 9);

  /* ------------------------------ skills */
  const skill = (row) =>
    db.insert(skills, {
      id: randomUUID(),
      createdBy: "user",
      botId: null,
      createdAt: ago({ d: 18 }),
      updatedAt: ago({ d: 6 }),
      ...row,
    });
  await skill({
    name: "weekly-status",
    description: "Write the Friday status update for the team and investors.",
    instructions: `Write the weekly status update.

1. Read the task board and list what moved to done this week.
2. Group it under **Shipped**, **In progress** and **At risk**. One line each, with the owner.
3. End with the single most important thing for next week.
4. Keep it under 200 words. No filler.`,
  });
  await skill({
    name: "meeting-notes",
    description: "Turn raw notes from a call into decisions and follow-ups.",
    instructions: `Turn the notes into:

- **Decisions** (what was agreed, one line each)
- **Follow-ups** (who, what, by when)
- **Open questions**

Add each follow-up to the task board with the right owner.`,
    updatedAt: ago({ d: 2 }),
  });
  await skill({
    name: "expense-report",
    description: "Collect receipts and invoices into a monthly expense summary.",
    instructions: `Search the inbox and shared/invoices for this month's receipts. Make a table of date, vendor, amount and category, total it, and flag anything over $200 or without a receipt.`,
    createdBy: "bot",
    createdByBotId: mira.id,
  });
  await skill({
    name: "pr-description",
    description: "Write a clear pull request description from a branch's diff.",
    instructions: `Read the diff against main. Write: what was wrong, what changed, how it was tested, and anything a reviewer should look at twice. Link the issue if there is one.`,
    botId: kit.id,
  });
  await skill({
    name: "release-notes-voice",
    description: "Rewrite engineering changelog entries for customers.",
    instructions: `Rewrite each change as the benefit to a customer, in one sentence. Group as New, Faster, Fixed. Drop internal terms and PR numbers unless asked.`,
    botId: juno.id,
    createdBy: "bot",
    createdByBotId: juno.id,
  });
  await skill({
    name: "compare-options",
    description: "Compare three or more options in a table with one recommendation.",
    instructions: `Put the options in a table with the criteria that matter to Alex (price, time, risk). Bold the recommendation, give the single strongest reason, then list what you could not verify.`,
    botId: scout.id,
    createdBy: "bot",
    createdByBotId: scout.id,
  });
}

export async function seedVault(ctx: SeedContext) {
  const { db, bots, encryptionKey, chats, R } = ctx;
  const { iris, scout, kit, mira, juno } = bots;
  const item = async (
    row: RowWithDefaults<
      typeof vaultItems,
      "id" | "domain" | "botIds" | "lastUsedAt" | "createdAt" | "updatedAt" | "encrypted"
    >,
    secret,
  ) => {
    const id = randomUUID();
    await db.insert(vaultItems, {
      id,
      domain: null,
      botIds: null,
      lastUsedAt: null,
      createdAt: ago({ d: 20 }),
      updatedAt: ago({ d: 7 }),
      ...row,
      encrypted: seal(JSON.stringify(secret), encryptionKey),
    });
    return id;
  };
  const login = (name, domain, username, botIds, last) =>
    item(
      { kind: "login", name, domain, hint: username, botIds, lastUsedAt: last },
      { username, password: "showcase-not-a-real-password" },
    );
  await login("GitHub", "github.com", "alex@kestrel.team", [kit.id, iris.id], ago({ h: 4 }));
  await login(
    "Kestrel CMS",
    "cms.kestrel.example",
    "alex@kestrel.team",
    [juno.id, iris.id],
    ago({ m: 18 }),
  );
  await login(
    "Stripe dashboard",
    "dashboard.stripe.com",
    "alex@kestrel.team",
    [iris.id],
    ago({ d: 3 }),
  );
  await login(
    "TAP Air Portugal",
    "flytap.com",
    "alex.rivera@kestrel.team",
    [iris.id, scout.id],
    ago({ d: 4 }),
  );
  await login(
    "Atlantic Product Summit",
    "atlanticsummit.example",
    "alex@kestrel.team",
    [iris.id, mira.id],
    ago({ d: 9 }),
  );
  const card = (name, hint, number, botIds, last) =>
    item(
      { kind: "card", name, hint, botIds, lastUsedAt: last },
      { number, expiry: "09/29", cvc: "000", name: "Alex Rivera", zip: "94110" },
    );
  const amex = await card(
    "Travel Amex",
    "Amex •••• 1007",
    "378282246310005",
    [iris.id, scout.id],
    ago({ d: 9 }),
  );
  const visa = await card(
    "Company Visa",
    "Visa •••• 4242",
    "4242424242424242",
    [iris.id, kit.id],
    ago({ d: 2 }),
  );

  const purchase = (row) =>
    db.insert(purchases, {
      id: randomUUID(),
      createdAt: ago({ d: 2 }),
      updatedAt: ago({ d: 2 }),
      ...row,
    });
  await purchase({
    botId: iris.id,
    cardId: amex,
    chatId: chats.irisFlights.id,
    runId: R.flights.id,
    approvalId: R.flightApproval.approvalId,
    amountCents: 84_230,
    merchant: "TAP Air Portugal",
    description: "Round trip SFO to LIS, economy, nonstop",
    status: "pending",
    createdAt: ago({ m: 47 }),
    updatedAt: ago({ m: 47 }),
  });
  await purchase({
    botId: iris.id,
    cardId: amex,
    amountCents: 49_500,
    merchant: "Atlantic Product Summit",
    description: "Conference ticket, 3 days",
    status: "paid",
    note: "Receipt emailed to alex@kestrel.team",
    createdAt: ago({ d: 9 }),
    updatedAt: ago({ d: 9 }),
  });
  await purchase({
    botId: iris.id,
    cardId: visa,
    amountCents: 1_498,
    merchant: "Registrar.io",
    description: "kestrel.dev domain renewal, 1 year",
    status: "paid",
    createdAt: ago({ d: 8 }),
    updatedAt: ago({ d: 8 }),
  });
  await purchase({
    botId: iris.id,
    cardId: visa,
    amountCents: 12_900,
    merchant: "Growth Masterclass",
    description: "Online workshop, 2 sessions",
    status: "denied",
    note: "Denied by Alex: not this month.",
    createdAt: ago({ d: 5 }),
    updatedAt: ago({ d: 5 }),
  });
  await purchase({
    botId: kit.id,
    cardId: visa,
    amountCents: 2_000,
    merchant: "Vercel",
    description: "Preview deployments, Pro seat",
    status: "paid",
    createdAt: ago({ d: 4 }),
    updatedAt: ago({ d: 4 }),
  });
}

/* ------------------------------------------------------------------ Memory, profile, lessons */

export async function seedMemory(ctx: SeedContext) {
  const { db, bots, R } = ctx;
  const { iris, scout, kit, mira, juno } = bots;
  const memory = async (row) => {
    const id = randomUUID();
    const state = row.state ?? "active";
    const created = row.createdAt ?? ago({ d: 10 });
    await db.insert(memoryItems, {
      id,
      botId: row.botId ?? null,
      kind: row.kind ?? "fact",
      content: row.content,
      key: row.key ?? null,
      fingerprint: memoryFingerprint(row.content),
      revision: 1,
      state,
      pinned: row.pinned ?? false,
      expiresAt: row.expiresAt ?? null,
      source: row.source ?? { type: "user" },
      createdAt: created,
      updatedAt: created,
    });
    await db.insert(memoryRevisions, {
      memoryId: id,
      revision: 1,
      content: row.content,
      snapshot: {
        pinned: row.pinned ?? false,
        key: row.key ?? null,
        kind: row.kind ?? "fact",
        expiresAt: row.expiresAt ?? null,
        state,
      },
      source: row.source ?? { type: "user" },
      createdAt: created,
    });
  };
  const bySource = (run) => ({ type: "bot", runId: run.id });

  // Shared, confirmed
  await memory({
    content:
      "Alex Rivera is the founder and CEO of Kestrel, a privacy-first web analytics tool. The team is six people plus contractors.",
    key: "about.company",
    pinned: true,
    createdAt: ago({ d: 30 }),
  });
  await memory({
    kind: "preference",
    content:
      "Lead with the answer, then the detail. Use a table when comparing three or more options.",
    key: "preference.style",
    pinned: true,
    createdAt: ago({ d: 29 }),
  });
  await memory({
    kind: "preference",
    content:
      "Flies out of SFO. Prefers a window seat, avoids red-eyes and connections shorter than 90 minutes.",
    key: "travel.preferences",
    createdAt: ago({ d: 26 }),
  });
  await memory({
    kind: "preference",
    content:
      "Protects 9:00 to 11:00 Pacific for deep work. No meetings before 11 unless it is an investor.",
    key: "calendar.deep-work",
    createdAt: ago({ d: 24 }),
  });
  await memory({
    content:
      "Dana Okafor is co-founder and CTO. Weekly 1:1 on Thursdays at 14:00. Mateo Silva is the contract designer.",
    key: "people.team",
    createdAt: ago({ d: 22 }),
  });
  await memory({
    content:
      "Marcus Lindqvist at Brightpath VC led the seed round. Cares about net revenue retention (currently 108%) and the EU hosting story.",
    key: "people.investors",
    source: bySource(R.miraTriage),
    createdAt: ago({ d: 11 }),
  });
  await memory({
    kind: "note",
    content:
      "Hold Wednesday to Friday of the Atlantic Product Summit in Lisbon. Two investor 1:1s: Thursday 1:30 PM and Friday 10:00 AM.",
    expiresAt: ctx.dates.confEnd,
    createdAt: ago({ d: 3 }),
    source: bySource(R.scoutFlights),
  });
  await memory({
    kind: "preference",
    content: "Company purchases go on the Company Visa. Travel goes on the Travel Amex.",
    key: "finance.cards",
    createdAt: ago({ d: 15 }),
  });
  // Suggested by a teammate, waiting to be confirmed
  await memory({
    state: "candidate",
    content: "Alex prefers to approve anything that sends email to a journalist, even replies.",
    source: bySource(R.miraTriage),
    createdAt: ago({ h: 9 }),
    botId: null,
  });
  await memory({
    state: "candidate",
    kind: "preference",
    content: "Alex likes release notes grouped as New, Faster, Fixed.",
    source: bySource(R.warNotes),
    createdAt: ago({ h: 19 }),
  });
  // Per teammate
  await memory({
    botId: kit.id,
    content:
      "tidepool lives in ~/code/tidepool on the computer. pnpm, vitest, strict TypeScript. The main branch is protected, so work on fix/ or feat/ branches.",
    key: "repo.tidepool",
    createdAt: ago({ d: 20 }),
    source: { type: "user" },
  });
  await memory({
    botId: kit.id,
    content:
      "Kestrel staging database is kestrel_staging. Never run migrations against production without Alex saying so.",
    key: "repo.kestrel-staging",
    pinned: true,
    createdAt: ago({ d: 17 }),
  });
  await memory({
    botId: mira.id,
    content: "Archive newsletters and receipts without asking. Starred senders are never archived.",
    key: "inbox.rules",
    createdAt: ago({ d: 18 }),
  });
  await memory({
    botId: juno.id,
    content:
      "Brand voice: plain, specific, confident. The product is 'Kestrel', never 'the Kestrel'. No exclamation marks.",
    key: "brand.voice",
    pinned: true,
    createdAt: ago({ d: 13 }),
  });
  await memory({
    botId: scout.id,
    content: "Alex prefers primary sources and a comparison table for three or more options.",
    key: "research.style",
    createdAt: ago({ d: 21 }),
  });
  await memory({
    botId: iris.id,
    content: "When Alex says 'this week' he means Monday to Friday, Pacific time.",
    key: "planning.week",
    createdAt: ago({ d: 23 }),
  });

  // The "about you" text, marked as already imported into memory so that opening Settings
  // doesn't copy it into a second, raw-Markdown note.
  const aboutMe = `Founder and CEO of Kestrel, a privacy-first web analytics tool. Based in San Francisco, on Pacific time. Shipping Kestrel 2.0, then Lisbon for the Atlantic Product Summit.`;
  await db.insert(memoryImports, { key: "legacy:profile" });
  await db.query(
    `insert into settings (id, monthly_cap_micros, timezone, about_me, about_me_updated_at)
     values (1, 20000000, $1, $2, $3)
     on conflict (id) do update set monthly_cap_micros = 20000000, timezone = $1, about_me = $2, about_me_updated_at = $3`,
    [TIMEZONE, aboutMe, ago({ d: 4 })],
  );

  // A lesson is a row of its own and also a pinned memory, the way the app keeps them together.
  const lesson = async (bot, run, text, daysAgo) => {
    const id = randomUUID();
    const createdAt = ago(daysAgo);
    const source = run ? { type: "feedback", runId: run.id } : { type: "import" };
    await db.insert(lessons, { id, botId: bot.id, runId: run?.id ?? null, text, createdAt });
    await db.insert(memoryItems, {
      id,
      botId: bot.id,
      kind: "lesson",
      content: text,
      fingerprint: memoryFingerprint(text),
      pinned: true,
      source: source,
      legacyKey: `legacy:lesson:${id}`,
      createdAt,
      updatedAt: createdAt,
    });
    await db.insert(memoryRevisions, {
      memoryId: id,
      revision: 1,
      content: text,
      snapshot: { pinned: true, key: null, kind: "lesson", expiresAt: null, state: "active" },
      source: source,
      createdAt,
    });
    await db.insert(memoryImports, { key: `legacy:lesson:${id}` });
  };
  await lesson(
    juno,
    R.junoDraft1,
    "Keep intros to three sentences or fewer. Alex cuts anything that sounds like a press release.",
    { d: 2, h: 21 },
  );
  await lesson(
    juno,
    null,
    "Never write 'leverage', 'seamless' or 'unlock'. Say what the thing does instead.",
    { d: 12 },
  );
  await lesson(
    kit,
    R.kitMigration,
    "Run the whole suite, not only the files I changed, before saying a fix works.",
    { d: 6 },
  );
  await lesson(
    kit,
    R.kitBug,
    "Show the failing test first. Alex wants to see the bug before the fix.",
    { d: 1, h: 4 },
  );
  await lesson(
    mira,
    R.miraTriage,
    "Flag investor and press mail first, even when it looks like an FYI.",
    { d: 5 },
  );
  await lesson(
    scout,
    R.scoutPricing,
    "Say whether prices are billed monthly or annually. It changes the comparison.",
    { d: 6 },
  );
  await lesson(iris, null, "Name the exact cost or recipient in every approval request.", {
    d: 14,
  });
  await db.query("update bots set lessons_changed_at = now() where id = any($1::uuid[])", [
    [juno.id, kit.id, mira.id, scout.id, iris.id],
  ]);

  // A teammate suggesting a rewrite of its own instructions.
  const miraDef = (await db.query("select instructions from bots where id = $1", [mira.id])).rows[0]
    .instructions;
  await db.insert(instructionProposals, {
    id: randomUUID(),
    botId: mira.id,
    current: miraDef,
    proposed: miraDef.replace(
      "- Flag investors and the press first, even if the mail looks like an FYI.",
      "- Flag investors and the press first, even if the mail looks like an FYI. Put them under their own heading above everything else.\n- Journalists: never reply without Alex's OK, even to confirm a time.",
    ),
    reason:
      "You have asked me twice to put investor and press mail first, and to ask before answering journalists. I would rather have that as a standing rule than have you remind me.",
    runId: R.miraTriage.id,
    createdAt: ago({ h: 8 }),
  });
}

/* ------------------------------------------------------------------ Pages */

export async function seedPages(ctx: SeedContext) {
  const { db, bots, pageIds, pageHtml, thumbs, chats, R } = ctx;
  const { iris, scout, juno } = bots;
  const specs = [
    {
      key: "checklist",
      bot: iris,
      chat: chats.irisPlan,
      sourcePath: "/home/bot/bots/iris/launch-checklist.html",
      pinned: true,
      runs: [R.irisPlan, R.irisStatus],
      title: "Kestrel 2.0 launch checklist",
      summaries: [
        "Eight workstreams, owners and status, with the one at risk called out.",
        "Updated after the rollback rehearsal: restore time is down to 17 minutes.",
      ],
      notes: [
        "",
        "Rollback rehearsal went from 41 to 17 minutes. Moved readiness from 44% to 52%.",
      ],
      created: [{ d: 2, h: 4 }, { h: 3 }],
    },
    {
      key: "itinerary",
      bot: scout,
      chat: chats.scoutFlights,
      sourcePath: "/home/bot/bots/scout/lisbon-itinerary.html",
      pinned: true,
      runs: [R.scoutHotels],
      title: "Lisbon trip itinerary",
      summaries: [
        "Flights, hotel and a day-by-day plan around the Summit and your two investor 1:1s.",
      ],
      notes: [""],
      created: [{ d: 3, h: 20 }],
    },
    {
      key: "pricing",
      bot: scout,
      chat: ctx.chats.scoutPricing,
      sourcePath: "/home/bot/bots/scout/pricing-landscape.html",
      pinned: false,
      runs: [R.scoutPricing],
      title: "Analytics pricing landscape",
      summaries: ["Mid-tier plans from three comparable tools, with pageviews per dollar."],
      notes: [""],
      created: [{ d: 6 }],
    },
    {
      key: "announcement",
      bot: juno,
      chat: chats.junoPost,
      sourcePath: "/home/bot/bots/juno/kestrel-2-announcement.md",
      pinned: false,
      runs: [R.junoDraft1, R.junoDraft2, ctx.R.irisJunoFaq],
      title: "Kestrel 2.0 announcement (draft)",
      summaries: [
        "About 600 words: funnels, speed, EU hosting, the API and the v1 migration.",
        "Intro cut from 70 words to 27. Everything else is unchanged.",
        "Now with a four-question FAQ for teams upgrading from v1.",
      ],
      notes: [
        "",
        "Cut the intro to two sentences and removed 'we cannot wait for you to try it'.",
        "Added the upgrade FAQ at the end.",
      ],
      created: [
        { d: 3, h: 5 },
        { d: 2, h: 21 },
        { d: 1, h: 5, m: 55 },
      ],
    },
  ];
  ctx.pageRows = {};
  for (const spec of specs) {
    const ids = pageIds[spec.key];
    const latest = ids.versions.length - 1;
    const createdFirst = ago(spec.created[0]);
    const updated = ago(spec.created[latest]);
    await db.insert(pages, {
      id: ids.id,
      botId: spec.bot.id,
      chatId: spec.chat.id,
      title: spec.title,
      summary: spec.summaries[latest],
      sourcePath: spec.sourcePath,
      currentVersionId: ids.versions[latest],
      versionCount: ids.versions.length,
      pinned: spec.pinned,
      createdAt: createdFirst,
      updatedAt: updated,
    });
    for (const [index, versionId] of ids.versions.entries()) {
      const html = pageHtml[spec.key][index];
      const text = html
        .replace(/<style[\s\S]*?<\/style>/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      await db.insert(pageVersions, {
        id: versionId,
        pageId: ids.id,
        number: index + 1,
        botId: spec.bot.id,
        runId: spec.runs[index]?.id ?? null,
        title: spec.title,
        summary: spec.summaries[index],
        note: spec.notes[index],
        html,
        size: Buffer.byteLength(html),
        sha256: createHash("sha256").update(html).digest("hex"),
        text,
        thumbnail: thumbs.get(`${spec.key}${index + 1}:light`),
        thumbnailDark: thumbs.get(`${spec.key}${index + 1}:dark`),
        issues:
          index === 0 && spec.key === "pricing"
            ? [
                {
                  level: "warning",
                  message: "The table is wider than a phone screen; it scrolls sideways.",
                },
              ]
            : [],
        createdAt: ago(spec.created[index]),
      });
    }
  }
}

/* ------------------------------------------------------------------ Notifications, usage, credentials */

export async function seedNotifications(ctx: SeedContext) {
  const { db, bots, chats, R, pageIds } = ctx;
  const { iris, scout, kit, mira, juno } = bots;
  const n = (row) => db.insert(notifications, { id: randomUUID(), body: "", readAt: null, ...row });
  await n({
    kind: "approval",
    title: "Mira needs your approval",
    body: "Send an email to Priya Nair about your Summit 1:1 slots.",
    botId: mira.id,
    chatId: chats.miraTriage.id,
    runId: R.miraReply.id,
    createdAt: ago({ m: 70 }),
  });
  await n({
    kind: "approval",
    title: "Iris wants to pay $842.30",
    body: "TAP Air Portugal, round trip SFO to LIS, on the Travel Amex.",
    botId: iris.id,
    chatId: chats.irisFlights.id,
    runId: R.flights.id,
    createdAt: ago({ m: 47 }),
  });
  await n({
    kind: "run_finished",
    title: "Kit opened a pull request",
    body: "tidepool #58: Keep wall-clock time across DST in recurrences.",
    botId: kit.id,
    chatId: chats.kitBug.id,
    runId: R.kitPush.id,
    createdAt: ago({ m: 22 }),
  });
  await n({
    kind: "takeover_request",
    title: "Juno needs you to take over",
    body: "The CMS is asking for a 6-digit code from your authenticator app.",
    botId: juno.id,
    chatId: chats.junoCms.id,
    runId: R.junoCms.id,
    createdAt: ago({ m: 16 }),
  });
  await n({
    kind: "bot_message",
    title: "Mira: 3 emails need your reply",
    body: "Marcus (Brightpath), Priya (Summit) and Sam (The Weekly Stack).",
    botId: mira.id,
    chatId: chats.miraTriage.id,
    runId: R.miraTriage.id,
    createdAt: ago({ h: 9 }),
  });
  await n({
    kind: "run_failed",
    title: "Kit couldn't finish: Update the changelog for a new release",
    body: "Interrupted when the computer restarted.",
    botId: kit.id,
    chatId: ctx.chats.kitSched?.id ?? chats.kitBug.id,
    createdAt: ago({ h: 6 }),
  });
  await n({
    kind: "run_finished",
    title: "Iris finished: launch status",
    body: "One real blocker, and it is shrinking.",
    botId: iris.id,
    chatId: chats.irisPlan.id,
    runId: R.irisStatus.id,
    readAt: ago({ h: 3 }),
    createdAt: ago({ h: 3 }),
  });
  await n({
    kind: "run_finished",
    title: "Juno published a page",
    body: "Kestrel 2.0 announcement (draft), version 3.",
    botId: juno.id,
    chatId: chats.irisPlan.id,
    pageId: pageIds.announcement.id,
    readAt: ago({ d: 1 }),
    createdAt: ago({ d: 1, h: 5 }),
  });
  await n({
    kind: "run_finished",
    title: "Scout finished: Lisbon hotels",
    body: "Stay at The Quiet Fig in Chiado.",
    botId: scout.id,
    chatId: chats.scoutFlights.id,
    runId: R.scoutHotels.id,
    readAt: ago({ d: 3 }),
    createdAt: ago({ d: 3, h: 19 }),
  });
  await n({
    kind: "run_finished",
    title: "Kit finished: migration dry run",
    body: "39 of 40 workspaces migrated cleanly, and the one failure is fixed.",
    botId: kit.id,
    runId: R.kitMigration.id,
    chatId: ctx.chats.kitMigration?.id ?? chats.kitBug.id,
    readAt: ago({ d: 3 }),
    createdAt: ago({ d: 3 }),
  });
}

export async function seedUsageAndSettings(ctx: SeedContext) {
  const { db, bots, encryptionKey } = ctx;
  const all = Object.values(bots) as { id: string }[];
  // Spread some extra usage across the month so the totals look lived in.
  const monthStart = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1, 2),
  );
  const span = Math.max(3_600_000, Date.now() - monthStart.getTime() - 3_600_000);
  for (let i = 0; i < 36; i++) {
    const bot = all[i % all.length];
    const apiKey = i % 3 === 0;
    const input = 90_000 + ((i * 53_000) % 420_000);
    const output = 2_000 + ((i * 3_100) % 28_000);
    await db.insert(usageEntries, {
      id: randomUUID(),
      botId: bot.id,
      authMode: apiKey ? "api_key" : "plan",
      inputTokens: input,
      cachedInputTokens: Math.round(input * 0.58),
      outputTokens: output,
      costMicros: apiKey ? Math.round(input * 1.4 + output * 9) : 0,
      idempotencyKey: `showcase:filler:${i}`,
      createdAt: new Date(monthStart.getTime() + Math.round((span * (i + 1)) / 37)),
    });
  }
  await db.insert(credentials, {
    kind: "openai_api_key",
    encrypted: seal("sk-showcase-not-a-real-key-cafe", encryptionKey),
    hint: "sk-…cafe",
  });
  await db.insert(nativePushDevices, {
    token: "showcase-fcm-token-pixel",
    platform: "android",
    device: "Pixel 9",
    lastSentAt: ago({ h: 1 }),
  });
  await db.query(
    `insert into email_settings (id, domain, inbound_token, last_received_at) values (1, 'kestrel.team', $1, $2)
     on conflict (id) do update set domain = 'kestrel.team', last_received_at = $2`,
    [randomBytes(18).toString("base64url"), ago({ h: 5, m: 10 })],
  );
}
