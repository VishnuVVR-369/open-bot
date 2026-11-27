import type { ScheduleView, TriggerView } from "@open-bot/api";
import { describe, expect, it } from "vitest";
import {
  asSchedule,
  asTrigger,
  automationEditHref,
  automationForm,
  automationHref,
  automationSections,
  automationsHref,
  canTurnOn,
  checkOutcome,
  clockOf,
  findAutomation,
  formChanged,
  formProblem,
  lastLine,
  mainAction,
  minuteChoices,
  patchOf,
  rebaseForm,
  RetryKeys,
  stateBadge,
  timeLabel,
  timeOf,
  webOnlyNote,
  whenLine,
  zoneNote,
} from "./automations";

const now = new Date("2026-11-28T10:00:00Z");

function schedule(patch: Partial<ScheduleView> = {}): ScheduleView {
  return {
    id: "s1",
    teammateId: "ana",
    title: "Morning brief",
    prompt: "Brief me",
    kind: "cron",
    cron: "0 9 * * 1-5",
    runAt: null,
    timezone: "UTC",
    enabled: true,
    quiet: false,
    createdBy: "user",
    nextRunAt: "2026-11-30T09:00:00.000Z",
    lastRunAt: null,
    lastRun: null,
    ...patch,
  };
}

function trigger(patch: Partial<TriggerView> = {}): TriggerView {
  return {
    id: "t1",
    teammateId: "ana",
    kind: "watch",
    title: "Kettle price",
    prompt: "Tell me the price",
    enabled: true,
    createdBy: "user",
    url: "https://www.shop.example/kettle",
    intervalMinutes: 60,
    lookFor: null,
    connectionId: null,
    account: null,
    query: null,
    leadMinutes: null,
    hookPath: null,
    nextCheckAt: null,
    lastCheckedAt: null,
    lastError: null,
    lastFiredAt: null,
    lastRun: null,
    ...patch,
  };
}

describe("the automations list", () => {
  it("groups everyone's, or one teammate's, in the web's order", () => {
    const sections = automationSections(
      [schedule(), schedule({ id: "s2", teammateId: "ben" })],
      [
        trigger({ id: "hook", kind: "webhook" }),
        trigger({ id: "mail", kind: "gmail" }),
        trigger({ id: "page" }),
        trigger({ id: "cal", kind: "calendar", teammateId: "ben" }),
      ],
    );
    expect(sections.map((section) => [section.key, section.items.map((item) => item.id)])).toEqual([
      ["schedule", ["s1", "s2"]],
      ["watch", ["page"]],
      ["accounts", ["mail", "cal"]],
      ["webhook", ["hook"]],
    ]);
    const ben = automationSections(
      [schedule(), schedule({ id: "s2", teammateId: "ben" })],
      [trigger({ id: "cal", kind: "calendar", teammateId: "ben" })],
      "ben",
    );
    expect(ben.flatMap((section) => section.items.map((item) => item.id))).toEqual(["s2", "cal"]);
  });

  it("finds one by its type and id, telling a schedule from a trigger with the same id", () => {
    expect(
      findAutomation("schedule", "x", [schedule({ id: "x" })], [trigger({ id: "x" })]),
    ).toMatchObject({ type: "schedule", title: "Morning brief" });
    expect(
      findAutomation("trigger", "x", [schedule({ id: "x" })], [trigger({ id: "x" })]),
    ).toMatchObject({ type: "trigger", title: "Kettle price" });
    expect(findAutomation("trigger", "x", [], undefined)).toBeNull();
    expect(automationHref({ type: "trigger", id: "t1" })).toBe("/automations/trigger/t1");
    expect(automationEditHref({ type: "schedule", id: "s1" })).toBe(
      "/automations/schedule/s1/edit",
    );
    expect(automationsHref("a b")).toBe("/automations?teammate=a%20b");
  });

  it("says Off, or Done for a reminder that already ran, which has no switch", () => {
    expect(stateBadge(asSchedule(schedule()))).toBeNull();
    expect(stateBadge(asSchedule(schedule({ enabled: false })))).toBe("Off");
    const done = asSchedule(
      schedule({ kind: "once", cron: null, enabled: false, lastRunAt: "2026-11-27T09:00:00Z" }),
    );
    expect(stateBadge(done)).toBe("Done");
    expect(canTurnOn(done)).toBe(false);
    expect(canTurnOn(asTrigger(trigger({ enabled: false })))).toBe(true);
  });

  it("runs a schedule now, checks a watch or an account now, and does neither to a webhook", () => {
    expect(mainAction(asSchedule(schedule()))).toEqual({ kind: "run", label: "Run now" });
    expect(mainAction(asTrigger(trigger({ kind: "gmail" })))?.kind).toBe("check");
    expect(mainAction(asTrigger(trigger({ kind: "webhook" })))).toBeNull();
  });

  it("says when each runs, or what it watches, in a line", () => {
    const routine = asSchedule(schedule({ quiet: true }));
    expect(whenLine(routine, { now })).toMatch(
      /^Weekdays at 9:00 AM · next (Sun|Mon|Tue) \d+:\d\d (AM|PM) · tells you only if something changed$/,
    );
    const due = asSchedule(schedule({ nextRunAt: "2026-11-28T09:00:00.000Z" }));
    expect(whenLine(due, { now, computerOnline: false })).toBe(
      "Weekdays at 9:00 AM · waiting for the computer",
    );
    expect(whenLine(asSchedule(schedule({ enabled: false })), { now })).toBe("Weekdays at 9:00 AM");
    expect(whenLine(asTrigger(trigger({ lookFor: "in stock" })), { now })).toBe(
      "shop.example/kettle · every hour · waiting for “in stock”",
    );
    expect(whenLine(asTrigger(trigger({ kind: "webhook" })), { now })).toBe(
      "Webhook · not called yet",
    );
    expect(
      whenLine(
        asTrigger(trigger({ kind: "calendar", account: "me@example.com", leadMinutes: 15 })),
        { now },
      ),
    ).toBe("me@example.com · 15 minutes before each event");
  });

  it("says how it went last, a failed check first", () => {
    expect(lastLine(asSchedule(schedule()), now)).toBeNull();
    expect(
      lastLine(
        asSchedule(
          schedule({
            lastRun: { id: "r", status: "failed", chatId: "c" },
            lastRunAt: "2026-11-28T09:30:00Z",
          }),
        ),
        now,
      ),
    ).toEqual({ text: "Last run failed 30m ago", failed: false });
    expect(
      lastLine(
        asTrigger(
          trigger({ lastError: "404", lastRun: { id: "r", status: "completed", chatId: "c" } }),
        ),
        now,
      ),
    ).toEqual({ text: "Last check failed: 404", failed: true });
    expect(lastLine(asTrigger(trigger()), now)?.text).toBe("Checking for the first time…");
    expect(
      lastLine(asTrigger(trigger({ kind: "gmail", lastCheckedAt: "2026-11-28T09:58:00Z" })), now)
        ?.text,
    ).toBe("No new mail yet · checked 2m ago");
    expect(lastLine(asTrigger(trigger({ kind: "webhook" })), now)).toBeNull();
  });

  it("says what Check now found, and who's on it", () => {
    expect(
      checkOutcome(trigger(), { ok: true, changed: true, summary: "The price dropped" }, "Ana"),
    ).toEqual({
      title: "“Kettle price” changed",
      body: "The price dropped. Ana is on it.",
      failed: false,
    });
    expect(
      checkOutcome(trigger(), { ok: true, changed: false, summary: "No change" }, "Ana"),
    ).toEqual({ title: "No change", body: null, failed: false });
    expect(
      checkOutcome(
        trigger({ kind: "gmail" }),
        { ok: false, changed: false, summary: "Signed out" },
        "Ana",
      ),
    ).toEqual({ title: "Couldn't check for new mail", body: "Signed out", failed: true });
  });

  it("names what only the web changes, and the zone times are in", () => {
    expect(webOnlyNote(asTrigger(trigger({ kind: "webhook" })))).toBe(
      "To see or change its URL, test it or change what it does, open Automations in open-bot on a computer.",
    );
    expect(zoneNote("Europe/Berlin", "Europe/Berlin")).toBe("Times in Europe/Berlin");
    expect(zoneNote("Europe/Berlin", "Asia/Kolkata")).toBe(
      "Times in Europe/Berlin. This phone is on Asia/Kolkata.",
    );
  });
});

describe("editing an automation on the phone", () => {
  it("sends only what changed, the name trimmed", () => {
    const automation = asSchedule(schedule());
    const start = automationForm(automation, now);
    expect(formChanged(start, { ...start, title: " Morning brief  " })).toBe(false);
    expect(patchOf(automation, start, start)).toBeNull();
    expect(patchOf(automation, start, { ...start, title: "  Daily brief " })).toEqual({
      type: "schedule",
      patch: { scheduleId: "s1", title: "Daily brief" },
    });
    expect(
      patchOf(automation, start, { ...start, timing: { ...start.timing!, time: "07:30" } }),
    ).toEqual({
      type: "schedule",
      patch: { scheduleId: "s1", timing: { cron: "30 7 * * 1-5", at: null } },
    });
    const watch = asTrigger(trigger());
    const watchStart = automationForm(watch, now);
    expect(watchStart).toMatchObject({ timing: null, intervalMinutes: 60, leadMinutes: null });
    expect(patchOf(watch, watchStart, { ...watchStart, intervalMinutes: 360 })).toEqual({
      type: "trigger",
      patch: { triggerId: "t1", intervalMinutes: 360 },
    });
    const calendar = asTrigger(trigger({ kind: "calendar", leadMinutes: null }));
    expect(automationForm(calendar, now)).toMatchObject({ intervalMinutes: null, leadMinutes: 30 });
  });

  it("refuses an empty name or a time in the past before sending", () => {
    const automation = asSchedule(
      schedule({ kind: "once", cron: null, runAt: "2026-12-01T09:00:00.000Z" }),
    );
    const start = automationForm(automation, now);
    expect(start.timing).toMatchObject({ kind: "once", at: "2026-12-01T09:00" });
    expect(formProblem(automation, start, now)).toBeNull();
    expect(formProblem(automation, { ...start, title: "  " }, now)).toBe("Give it a name.");
    expect(
      formProblem(
        automation,
        { ...start, timing: { ...start.timing!, at: "2026-11-27T09:00" } },
        now,
      ),
    ).toBe("That time is in the past.");
    expect(
      formProblem(asTrigger(trigger()), automationForm(asTrigger(trigger()), now), now),
    ).toBeNull();
  });

  it("follows what you didn't touch when it changes elsewhere, and keeps what you did", () => {
    const before = asSchedule(schedule());
    const start = automationForm(before, now);
    const draft = { start, form: { ...start, title: "Daily brief" } };
    // On the web meanwhile: a new time, and another name.
    const fresh = automationForm(
      asSchedule(schedule({ title: "Brief", cron: "0 8 * * 1-5" })),
      now,
    );
    const rebased = rebaseForm(draft, fresh);
    expect(rebased.start).toBe(fresh);
    expect(rebased.form.title).toBe("Daily brief");
    expect(rebased.form.timing?.time).toBe("08:00");
    // Nothing new: the draft stays as it is.
    expect(rebaseForm(draft, automationForm(before, now))).toBe(draft);
  });
});

describe("asking once", () => {
  it("keeps the same id for a retry until the ask is answered", () => {
    let next = 0;
    const keys = new RetryKeys(() => `key-${++next}`);
    expect(keys.for("s1")).toBe("key-1");
    expect(keys.for("s1")).toBe("key-1");
    expect(keys.for("s2")).toBe("key-2");
    keys.done("s1");
    expect(keys.for("s1")).toBe("key-3");
  });
});

describe("picking a time", () => {
  it("goes between the form's 24-hour time and a 12-hour clock", () => {
    expect(timeLabel("00:05")).toBe("12:05 AM");
    expect(timeLabel("13:30")).toBe("1:30 PM");
    expect(clockOf("00:05")).toEqual({ hour12: 12, minute: 5, pm: false });
    expect(clockOf("12:00")).toEqual({ hour12: 12, minute: 0, pm: true });
    expect(timeOf(12, 0, false)).toBe("00:00");
    expect(timeOf(12, 30, true)).toBe("12:30");
    expect(timeOf(7, 5, true)).toBe("19:05");
    expect(minuteChoices(15)).toHaveLength(12);
    expect(minuteChoices(7)).toEqual([0, 5, 7, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  });
});
