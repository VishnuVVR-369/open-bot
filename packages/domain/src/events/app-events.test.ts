import { describe, expect, it } from "vitest";
import { APP_EVENT_TYPES, parseAppEvent } from "./app-events";

describe("parseAppEvent", () => {
  it("reads every event type", () => {
    for (const type of APP_EVENT_TYPES) expect(parseAppEvent({ type })).toEqual({ type });
  });

  it("reads a new notification with its id, and a read-state change without one", () => {
    expect(parseAppEvent({ type: "notification", id: "n1" })).toEqual({
      type: "notification",
      id: "n1",
    });
    expect(parseAppEvent({ type: "notification" })).toEqual({ type: "notification" });
  });

  it("returns null for an event this version doesn't know, or something that isn't one", () => {
    expect(parseAppEvent({ type: "something-new" })).toBeNull();
    expect(parseAppEvent({ type: "notification", id: 42 })).toBeNull();
    expect(parseAppEvent("chats")).toBeNull();
    expect(parseAppEvent(null)).toBeNull();
  });
});
