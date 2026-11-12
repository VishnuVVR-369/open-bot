import { expect, test } from "vitest";
import { TOOLS, toolsFor } from "./definitions";

/** Sorted the same way however the tools are grouped in code: tools by name, keys, `required`. */
function canonical(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => canonical(item));
    if (key === "required") return [...(items as string[])].sort();
    if (key === "tools" || key === undefined)
      return [...items].sort((a, b) =>
        String((a as { name: string }).name).localeCompare(String((b as { name: string }).name)),
      );
    return items;
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((name) => [name, canonical((value as Record<string, unknown>)[name], name)]),
    );
  return value;
}

// Every tool as Codex sees it: names, descriptions and input schemas. A change here changes what
// teammates are offered, so review the snapshot diff like code.
test("the tool list Codex sees", async () => {
  await expect(`${JSON.stringify(canonical(toolsFor()), null, 2)}\n`).toMatchFileSnapshot(
    "./__snapshots__/tools.json",
  );
});

// Swarm helpers do their one part: they don't reach the user, the team or the user's setup.
test("the tools swarm helpers may not call", () => {
  expect(
    TOOLS.filter((tool) => tool.helpers === "forbidden")
      .map((tool) => tool.name)
      .sort(),
  ).toEqual([
    "add_task",
    "ask_teammate",
    "cancel_automation",
    "create_bot",
    "create_webhook",
    "handoff_to_bot",
    "notify_user",
    "propose_instructions",
    "publish_page",
    "request_approval",
    "request_takeover",
    "save_skill",
    "schedule_task",
    "send_email",
    "set_bot_connection",
    "start_purchase",
    "start_swarm",
    "update_automation",
    "update_bot",
    "update_task",
    "watch_calendar",
    "watch_gmail",
    "watch_page",
  ]);
});
