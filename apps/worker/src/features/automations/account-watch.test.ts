import { describe, expect, it } from "vitest";
import {
  addedMessages,
  calendarWindow,
  compareHistoryIds,
  dueOccurrences,
  gmailMatchQuery,
  hasOtherGuests,
  occurrenceKey,
  oldestHistoryId,
  startsIn,
  type WatchedEvent,
} from "./account-watch";

describe("Gmail history", () => {
  it("compares history ids as numbers, past what a double holds", () => {
    expect(compareHistoryIds("9", "10")).toBe(-1);
    expect(compareHistoryIds("18446744073709551615", "18446744073709551614")).toBe(1);
    expect(compareHistoryIds("42", "42")).toBe(0);
    expect(oldestHistoryId(["120", "95", "1000"])).toBe("95");
    expect(oldestHistoryId([])).toBeNull();
  });

  it("finds mail added after a trigger's cursor, once each, without sent mail or drafts", () => {
    const history = [
      { id: "100", messagesAdded: [{ message: { id: "a", threadId: "t1", labelIds: ["INBOX"] } }] },
      { id: "101", messagesAdded: [{ message: { id: "b", threadId: "t2", labelIds: ["INBOX"] } }] },
      { id: "102", messagesAdded: [{ message: { id: "c", threadId: "t2", labelIds: ["SENT"] } }] },
      { id: "103", messagesAdded: [{ message: { id: "d", threadId: "t3", labelIds: ["DRAFT"] } }] },
      { id: "104", messagesAdded: [{ message: { id: "b", threadId: "t2", labelIds: ["INBOX"] } }] },
      { id: "105" },
      { id: "106", messagesAdded: [{ message: { id: "e", threadId: "t4" } }] },
    ];
    expect(addedMessages(history, null).map((message) => message.id)).toEqual(["a", "b", "e"]);
    // A trigger that already saw up to 100 skips what it saw.
    expect(addedMessages(history, "100").map((message) => message.id)).toEqual(["b", "e"]);
    expect(addedMessages(history, "106")).toEqual([]);
  });

  it("keeps a trigger's own search whole, so an OR can't widen the rest", () => {
    expect(gmailMatchQuery("from:a OR from:b", 2)).toBe(
      "(from:a OR from:b) -in:sent -in:drafts -in:chats newer_than:2d",
    );
    expect(gmailMatchQuery("  ", 1)).toBe("-in:sent -in:drafts -in:chats newer_than:1d");
    expect(gmailMatchQuery(null, 1)).toBe("-in:sent -in:drafts -in:chats newer_than:1d");
  });
});

describe("Calendar timing", () => {
  const now = new Date("2026-11-06T09:00:00Z");
  const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
  const event = (id: string, minutes: number, extra: Partial<WatchedEvent> = {}): WatchedEvent => ({
    id,
    status: "confirmed",
    start: { dateTime: at(minutes) },
    ...extra,
  });
  const options = { now, leadMinutes: 30, pollMinutes: 5, filter: "all" as const };

  it("looks from now to past the lead time, by two checks", () => {
    expect(calendarWindow(now, 30, 5)).toEqual({
      timeMin: "2026-11-06T09:00:00.000Z",
      timeMax: "2026-11-06T09:40:00.000Z",
    });
  });

  it("wakes for events whose lead time has come, give or take half a check", () => {
    const due = dueOccurrences(
      [
        event("soon", 31), // wakes at 9:01, within half a check
        event("later", 34), // wakes at 9:04, next check
        event("now", 10), // its lead time passed between checks: still due
        event("late", -5), // started 5 minutes ago: a late check still counts
        event("over", -20), // long started
      ],
      options,
    );
    expect(due.map((entry) => entry.event.id)).toEqual(["late", "now", "soon"]);
  });

  it("skips cancelled, all-day and declined events, and events without guests when asked", () => {
    const me = { email: "me@example.com", self: true };
    const events = [
      event("cancelled", 20, { status: "cancelled" }),
      { id: "all-day", start: { date: "2026-11-06" } },
      event("declined", 20, { attendees: [{ ...me, responseStatus: "declined" }] }),
      event("alone", 20, { attendees: [me, { email: "room@example.com", resource: true }] }),
      event("meeting", 21, {
        attendees: [me, { email: "priya@example.com", responseStatus: "accepted" }],
      }),
    ];
    expect(dueOccurrences(events, options).map((entry) => entry.event.id)).toEqual([
      "alone",
      "meeting",
    ]);
    expect(
      dueOccurrences(events, { ...options, filter: "guests" }).map((entry) => entry.event.id),
    ).toEqual(["meeting"]);
    expect(hasOtherGuests(events[3] as WatchedEvent)).toBe(false);
  });

  it("keys an occurrence by its time, so a moved event wakes the teammate again", () => {
    const before = occurrenceKey(event("abc_20261106T093000Z", 30));
    const moved = occurrenceKey(event("abc_20261106T093000Z", 60));
    expect(before).toBe("event:abc_20261106T093000Z@2026-11-06T09:30:00.000Z");
    expect(moved).not.toBe(before);
    // The same instant written in another offset is the same occurrence.
    expect(occurrenceKey({ id: "x", start: { dateTime: "2026-11-06T10:30:00+01:00" } })).toBe(
      occurrenceKey({ id: "x", start: { dateTime: "2026-11-06T09:30:00Z" } }),
    );
    expect(occurrenceKey({ id: "y", start: { date: "2026-11-06" } })).toBeNull();
  });

  it("says how soon an event starts", () => {
    expect(startsIn(new Date(at(30)), now)).toBe("starts in 30 minutes");
    expect(startsIn(new Date(at(1)), now)).toBe("starts in 1 minute");
    expect(startsIn(new Date(at(0)), now)).toBe("is starting now");
    expect(startsIn(new Date(at(-4)), now)).toBe("started 4 minutes ago");
    expect(startsIn(new Date(at(90)), now)).toBe("starts in 1.5 hours");
    expect(startsIn(new Date(at(60)), now)).toBe("starts in 1 hour");
    expect(startsIn(new Date(at(1440)), now)).toBe("starts in 1 day");
  });
});
