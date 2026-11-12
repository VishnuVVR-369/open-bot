import { expect, test } from "vitest";
import { TOOL_DISPLAY, TOOL_ICON_LIST, toolDisplay } from "./tool-display";

test("a tool step gets its own icon, its account's, or the default", () => {
  expect(toolDisplay("send_email")).toEqual({ icon: "email", asksApproval: true });
  expect(toolDisplay("notion.search")).toEqual({ icon: "notes" });
  expect(toolDisplay("calendar.create_event").icon).toBe("calendar");
  expect(toolDisplay("set_chat_title")).toEqual({ icon: "tool" });
  expect(toolDisplay("unknown.thing")).toEqual({ icon: "tool" });
  for (const name of [
    "constructor",
    "toString",
    "__proto__",
    "constructor.x",
    "hasOwnProperty.y",
    "",
  ])
    expect(toolDisplay(name)).toEqual({ icon: "tool" });
  // Retired tools keep their icon in older chats.
  expect(toolDisplay("list_schedules").icon).toBe("schedule");
});

test("only the tools that exist to ask fold into their approval card", () => {
  const asking = Object.keys(TOOL_DISPLAY).filter((name) => TOOL_DISPLAY[name]!.asksApproval);
  expect(asking.sort()).toEqual(["request_approval", "send_email", "start_purchase"]);
});

test("every icon a tool uses is a known meaning", () => {
  for (const display of Object.values(TOOL_DISPLAY)) expect(TOOL_ICON_LIST).toContain(display.icon);
});
