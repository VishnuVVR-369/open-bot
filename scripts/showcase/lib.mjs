// Helpers for the showcase seed: time, ids, SQL inserts and the builders for chats and runs.
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

/* ------------------------------------------------------------------ Time */

export const NOW = new Date();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A moment `d` days, `h` hours and `m` minutes before now. */
export function ago({ d = 0, h = 0, m = 0, s = 0 } = {}) {
  return new Date(NOW.getTime() - d * DAY - h * HOUR - m * MINUTE - s * 1000);
}
export function fromNow({ d = 0, h = 0, m = 0 } = {}) {
  return new Date(NOW.getTime() + d * DAY + h * HOUR + m * MINUTE);
}
export const plus = (date, ms) => new Date(date.getTime() + ms);

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
/** "Tue Nov 17" in the showcase timezone. */
export function fmtDay(date, tz = TIMEZONE) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.weekday} ${parts.month} ${parts.day}`;
}
export function fmtShort(date, tz = TIMEZONE) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.month} ${parts.day}`;
}
/** "2026-11-17" in the showcase timezone. */
export function isoDay(date, tz = TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(date);
}
export { DAY_NAMES, MONTH_NAMES };

export const TIMEZONE = "America/Los_Angeles";

function zoned(date, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    dow: DAY_NAMES.indexOf(parts.weekday),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

/** Every occurrence of "minute hour * * dow-set" between two instants, found minute by minute. */
function occurrences({ hour, minute, days }, from, to, tz) {
  const found = [];
  const start = new Date(Math.ceil(from.getTime() / MINUTE) * MINUTE);
  // Step in 15 minute strides until the clock matches, then in days; cheap and exact enough.
  for (let t = start.getTime(); t <= to.getTime(); t += MINUTE) {
    const z = zoned(new Date(t), tz);
    if (z.hour === hour && z.minute === minute && days.includes(z.dow)) {
      found.push(new Date(t));
      t += 23 * HOUR; // skip to the next day
    }
  }
  return found;
}

/** The next time a daily/weekly schedule fires after now. */
export function nextOccurrence(spec, tz = TIMEZONE) {
  return occurrences(spec, NOW, fromNow({ d: 8 }), tz)[0];
}
/** The latest `count` times it fired before now, oldest first. */
export function lastOccurrences(spec, count, tz = TIMEZONE) {
  const all = occurrences(spec, ago({ d: 21 }), NOW, tz);
  return all.slice(-count);
}

/** The next Tuesday at least 6 days away: launch day. */
export function nextLaunchDay() {
  for (let n = 6; n < 14; n++) {
    const d = fromNow({ d: n });
    if (zoned(d, TIMEZONE).dow === 2) return d;
  }
  return fromNow({ d: 10 });
}

/* ------------------------------------------------------------------ SQL */

/** Marks a value to be stored as JSON (jsonb), whatever its shape. */
export class J {
  constructor(value) {
    this.value = value;
  }
}
export const json = (value) => new J(value);

const snake = (key) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export class Db {
  constructor(client) {
    this.client = client;
    this.counts = {};
  }

  async insert(table, row) {
    const keys = Object.keys(row).filter((key) => row[key] !== undefined);
    const columns = keys.map((key) => `"${snake(key)}"`).join(", ");
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
    const values = keys.map((key) =>
      row[key] instanceof J ? JSON.stringify(row[key].value) : row[key],
    );
    await this.client.query(`insert into "${table}" (${columns}) values (${placeholders})`, values);
    this.counts[table] = (this.counts[table] ?? 0) + 1;
    return row;
  }

  query(sql, params) {
    return this.client.query(sql, params);
  }
}

/* ------------------------------------------------------------------ Secrets */

/** The same AES-256-GCM sealing the app uses for secrets at rest (iv.tag.data, base64url). */
export function seal(plaintext, base64Key) {
  const key = Buffer.from(base64Key, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".");
}

export function memoryFingerprint(content) {
  const normalized = content.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}

/* ------------------------------------------------------------------ Timeline items */

let itemCounter = 0;
const itemId = () => `item_${(++itemCounter).toString().padStart(4, "0")}`;

export const msg = (text, phase = "final") => ({
  kind: "message",
  text,
  phase,
  dur: phase === "final" ? 4000 : 1500,
});
export const note = (text) => msg(text, "commentary");
export const think = (text) => ({ kind: "reasoning", text, dur: 3500 });
export const cmd = (
  command,
  output,
  { exit = 0, ms = 1800, cwd = "/home/bot/bots/work" } = {},
) => ({
  kind: "command",
  command: `/bin/bash -lc ${shellQuote(command)}`,
  cwd,
  output,
  exitCode: exit,
  durationMs: ms,
  dur: ms + 400,
  failed: exit !== 0,
});
export const files = (changes, dur = 2200) => ({ kind: "file_change", changes, dur });
export const tool = (name, label, { result, args = {}, error } = {}) => ({
  kind: "tool",
  name,
  label,
  args,
  result,
  error,
  dur: 1400,
  failed: Boolean(error),
});
export const search = (query) => ({ kind: "web_search", query, dur: 3200 });
export const plan = (steps) => ({
  kind: "plan",
  steps: steps.map(([step, status = "completed"]) => ({ step, status })),
  dur: 600,
});
export const screen = (action, shot, dur = 2600) => ({ kind: "computer", action, shot, dur });
export const handoff = (toBot, message) => ({
  kind: "handoff",
  toBotId: toBot.id,
  toBotName: toBot.name,
  message,
  dur: 900,
});
export const pageItem = ({ pageId, versionId, version, title, summary }) => ({
  kind: "page",
  pageId,
  versionId,
  version,
  title,
  summary,
  dur: 1200,
});
export const errorItem = (message) => ({ kind: "error", message, dur: 300 });
/** An approval card. `decision` is pending, approved, denied or expired. */
export const approval = (spec) => ({
  kind: "approval",
  approvalId: randomUUID(),
  approvalKind: spec.kind,
  decision: spec.decision ?? "pending",
  title: spec.title,
  detail: spec.detail ?? "",
  subject: spec.subject,
  askEveryTime: spec.askEveryTime,
  preview: spec.preview,
  dur: 500,
});
export const takeoverRequest = (reason, resolution = "pending") => ({
  kind: "takeover_request",
  takeoverRequestId: randomUUID(),
  reason,
  resolution,
  dur: 400,
});

function shellQuote(script) {
  return `'${script.replaceAll("'", `'\\''`)}'`;
}

/* ------------------------------------------------------------------ Seeding chats and runs */

export class Seeder {
  /**
   * @param {Db} db
   * @param {{ shots: Map<string, Buffer>, encryptionKey: string }} context
   */
  constructor(db, context) {
    this.db = db;
    this.shots = context.shots;
    this.activity = new Map(); // chatId -> latest activity
    this.completions = new Map(); // chatId -> latest completed run
    this.unread = new Set();
    this.runCount = 0;
  }

  touch(chatId, date) {
    const current = this.activity.get(chatId);
    if (!current || date > current) this.activity.set(chatId, date);
  }

  async chat({
    kind = "direct",
    title,
    titled = true,
    bot,
    members = [],
    createdAt,
    unread = false,
  }) {
    const id = randomUUID();
    await this.db.insert("chats", {
      id,
      kind,
      title,
      titled,
      botId: bot?.id ?? null,
      createdAt,
      lastActivityAt: createdAt,
      readAt: createdAt,
    });
    for (const member of members)
      await this.db.insert("chat_members", { chatId: id, botId: member.id, createdAt });
    this.touch(id, createdAt);
    if (unread) this.unread.add(id);
    return { id, kind, title };
  }

  async userMessage(
    chat,
    text,
    at,
    { mentions = [], attachments = [], via = "app", extra = {} } = {},
  ) {
    const id = randomUUID();
    await this.db.insert("messages", {
      id,
      chatId: chat.id,
      role: "user",
      text,
      attachments: json(attachments),
      mentions: json(mentions.map((bot) => bot.id)),
      via,
      dispatchStatus: "dispatched",
      createdAt: at,
      ...extra,
    });
    this.touch(chat.id, at);
    return { id, at };
  }

  /**
   * One run: its row, its timeline events, the approvals and screenshots it holds, and its usage.
   * Items run one after another from `at`; the last "final" message is the reply.
   */
  async run(chat, bot, spec) {
    const {
      id = randomUUID(),
      screenId = null,
      at,
      prompt,
      message = null,
      trigger = "user",
      items = [],
      status = "completed",
      waitingFor = null,
      error = null,
      rating = null,
      authMode = "plan",
      scheduleId = null,
      triggerId = null,
      parentRunId = null,
      readOutsideData = false,
      tokens = null,
    } = spec;
    const startedAt = plus(at, 1800);
    const finished = status === "completed" || status === "failed" || status === "interrupted";
    const events = [];
    const timeline = [];
    let cursor = startedAt;
    events.push({ at: startedAt, payload: { type: "status", status: "running" } });

    const approvalsToInsert = [];
    const artifactsToInsert = [];
    items.forEach((raw, index) => {
      const { dur = 2000, shot, failed, ...item } = raw;
      const last = index === items.length - 1;
      const running = !finished && last && status === "running";
      const begin = cursor;
      const end = plus(begin, dur);
      const base = { id: itemId(), startedAt: begin.toISOString() };
      let done = running ? "running" : failed ? "failed" : "completed";
      if (item.kind === "approval" && item.decision === "pending") done = "running";
      if (item.kind === "takeover_request" && item.resolution === "pending") done = "running";
      const full = { ...base, status: done, ...item };
      if (done !== "running") full.completedAt = end.toISOString();
      if (full.kind === "message" || full.kind === "reasoning") full.text = String(full.text);
      if (item.kind === "computer") {
        const bytes = this.shots.get(shot);
        if (bytes) {
          const artifactId = randomUUID();
          full.screenshotId = artifactId;
          artifactsToInsert.push({
            id: artifactId,
            runId: id,
            kind: "screenshot",
            mime: "image/png",
            bytes,
            createdAt: end,
          });
        }
      }
      if (item.kind === "approval") {
        approvalsToInsert.push({ item: full, begin, end });
      }
      timeline.push(full);
      events.push({ at: end, payload: { type: "item", item: full } });
      cursor = end;
    });

    const completedAt = finished ? plus(cursor, 1200) : null;
    const lastTime = completedAt ?? cursor;
    if (finished)
      events.push({
        at: completedAt,
        payload: { type: "status", status, ...(error ? { error } : {}) },
      });
    else if (status === "waiting")
      events.push({ at: cursor, payload: { type: "status", status: "waiting", waitingFor } });

    const finalText =
      timeline
        .filter((item) => item.kind === "message" && item.phase === "final")
        .map((item) => item.text)
        .join("\n\n") || null;

    await this.db.insert("runs", {
      id,
      chatId: chat.id,
      botId: bot.id,
      trigger,
      prompt,
      messageId: message?.id ?? null,
      scheduleId,
      triggerId,
      parentRunId,
      screenId,
      status,
      waitingFor,
      error,
      authMode,
      finalText,
      rating,
      readOutsideData,
      attachments: json([]),
      createdAt: at,
      startedAt,
      completedAt,
    });

    const input = tokens?.input ?? 9000 + timeline.length * 3200;
    const output = tokens?.output ?? 600 + (finalText?.length ?? 200) * 1.4;
    events.push({
      at: lastTime,
      payload: {
        type: "usage",
        inputTokens: input,
        cachedInputTokens: Math.round(input * 0.62),
        outputTokens: Math.round(output),
      },
    });
    for (const event of events)
      await this.db.insert("run_events", {
        runId: id,
        chatId: chat.id,
        payload: json(event.payload),
        createdAt: event.at,
      });
    for (const artifact of artifactsToInsert) await this.db.insert("artifacts", artifact);
    for (const { item, begin, end } of approvalsToInsert) {
      await this.db.insert("approvals", {
        id: item.approvalId,
        runId: id,
        botId: bot.id,
        chatId: chat.id,
        kind: item.approvalKind,
        title: item.title,
        detail: item.detail,
        payload: json({
          ...(item.subject ? { subject: item.subject } : {}),
          ...(item.askEveryTime ? { askEveryTime: true } : {}),
          ...(item.preview ? { preview: item.preview } : {}),
        }),
        status: item.decision,
        itemId: item.id,
        createdAt: begin,
        decidedAt: item.decision === "pending" ? null : plus(end, 4 * 60_000),
      });
    }
    if (authMode === "api_key" || status !== "queued") {
      await this.db.insert("usage_entries", {
        runId: id,
        botId: bot.id,
        authMode,
        inputTokens: input,
        cachedInputTokens: Math.round(input * 0.62),
        outputTokens: Math.round(output),
        costMicros: authMode === "api_key" ? Math.round(input * 2.5 + output * 10) : 0,
        idempotencyKey: `showcase:run:${id}`,
        createdAt: lastTime,
      });
    }

    this.touch(chat.id, lastTime);
    if (completedAt) {
      const current = this.completions.get(chat.id);
      if (!current || completedAt > current) this.completions.set(chat.id, completedAt);
    }
    this.runCount += 1;
    return { id, at, completedAt, timeline, items: timeline };
  }

  /** A message of yours plus the replies it got, one run per teammate. */
  async exchange(chat, { at, text, mentions = [], replies, attachments = [], extra = {} }) {
    const message = await this.userMessage(chat, text, at, { mentions, attachments, extra });
    const runs = [];
    let offset = 2500;
    for (const reply of replies) {
      const { bot, ...rest } = reply;
      runs.push(
        await this.run(chat, bot, {
          ...rest,
          at: plus(at, reply.delay ?? offset),
          prompt: text,
          message,
        }),
      );
      offset += 900;
    }
    return { message, runs };
  }

  /** Sets chats' last activity and read position once every run is in. */
  async finish() {
    for (const [chatId, last] of this.activity) {
      const completed = this.completions.get(chatId);
      const unread = this.unread.has(chatId) && completed;
      const readAt = unread ? plus(completed, -3 * HOUR) : last > NOW ? NOW : plus(last, 1000);
      await this.db.query("update chats set last_activity_at = $2, read_at = $3 where id = $1", [
        chatId,
        last,
        readAt > NOW ? NOW : readAt,
      ]);
    }
  }
}
