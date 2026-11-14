import { expect, test, vi } from "vitest";
import { z } from "zod";
import type { RunSession } from "../runs/session";
import { inputJsonSchema, parseArgs } from "../core/tool";
import { toolNamed, TOOLS, toolsFor } from "./definitions";
import { ToolHandlers } from "./handlers";
import type { ToolRegistryServices } from "./dependencies";

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

// Objects are closed to unlisted properties, but a record still takes any key with its value schema.
test("a tool input's JSON schema closes objects and keeps records open", () => {
  const schema = inputJsonSchema(
    z.object({
      headers: z.record(z.string(), z.string()),
      nested: z.object({ a: z.string() }),
    }),
  ) as { properties: Record<"headers" | "nested", { additionalProperties: unknown }> };
  expect(schema.properties.headers.additionalProperties).toEqual({ type: "string" });
  expect(schema.properties.nested.additionalProperties).toBe(false);
});

// A null is refused, not read as left out: a refused target must not become "yourself".
test("a null argument is refused like any other wrong type", () => {
  const tool = toolNamed("cancel_automation")!;
  const id = "00000000-0000-4000-8000-000000000001";
  expect(() => parseArgs(tool, { id, bot_id: null })).toThrow(); // vocabulary: allow
  expect(parseArgs(tool, { id })).toEqual({ id });
});

// An argument a tool doesn't take is refused, not dropped: a call that names its target with a
// key this worker doesn't know would otherwise act on the caller instead of that teammate. The
// rename to `teammate_id` rewrites stored approvals before this worker stops, so it must refuse it.
test("an argument the tool doesn't take is refused, not dropped", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const targeted = TOOLS.filter((tool) => "bot_id" in tool.input.shape); // vocabulary: allow
  expect(targeted.length).toBeGreaterThan(5);
  const cancel = toolNamed("cancel_automation")!;
  expect(() => parseArgs(cancel, { id, teammate_id: id })).toThrow(/teammate_id/);
  expect(parseArgs(cancel, { id, bot_id: id })).toEqual({ id, bot_id: id }); // vocabulary: allow
  for (const tool of targeted)
    expect(() => parseArgs(tool, { teammate_id: id }), tool.name).toThrow();
  // A tool whose handler takes more than it lists still gets those arguments.
  const remember = toolNamed("remember_about_user")!;
  expect(parseArgs(remember, { fact: "Vegetarian.", kind: "preference" })).toEqual({
    fact: "Vegetarian.",
    kind: "preference",
  });
});

// The mixed-version case the rename must survive: a newer worker's migration rewrites an approved
// schedule for another teammate to `teammate_id` while this worker still runs follow-ups. The call
// must fail before the handler runs, not schedule the work for the caller.
test("a schedule naming its target with an unknown key never reaches the handler", async () => {
  const touched: string[] = [];
  const services = new Proxy({ ctx: { log: { error: vi.fn() } } } as Record<string, unknown>, {
    get: (target, key: string) => (key === "ctx" ? target.ctx : void touched.push(key)),
  });
  const handlers = new ToolHandlers(services as unknown as ToolRegistryServices);
  touched.length = 0; // Only what the call touches counts, not wiring the handlers up.
  const session = { isHelper: false, now: () => "now" } as unknown as RunSession;
  const response = await handlers.handle(session, {
    tool: "schedule_task",
    callId: "call-1",
    arguments: {
      teammate_id: "00000000-0000-4000-8000-000000000002",
      title: "Build check",
      prompt: "Check the build",
      at: "2026-12-01T09:00:00Z",
    },
  } as never);
  expect(response.success).toBe(false);
  expect(response.contentItems[0]).toMatchObject({ text: expect.stringMatching(/teammate_id/) });
  expect(touched).toEqual([]);
});

test("calls are parsed with the tool's input before the handler runs", async () => {
  const requested = vi.fn(async () => ({ status: "dismissed" as const }));
  const handlers = new ToolHandlers({
    ctx: { log: { error: vi.fn() } },
    takeovers: { requestFromBot: requested }, // vocabulary: allow
  } as unknown as ToolRegistryServices);
  const session = { isHelper: false, now: () => "now" } as unknown as RunSession;
  const call = (args: Record<string, unknown>) =>
    handlers.handle(session, {
      tool: "request_takeover",
      callId: "call-1",
      arguments: args,
    } as never);

  const wrongType = await call({ reason: 5 });
  expect(wrongType.success).toBe(false);
  expect(wrongType.contentItems[0]).toMatchObject({
    text: expect.stringMatching(/^reason: /),
  });
  const nullReason = await call({ reason: null });
  expect(nullReason.success).toBe(false);
  expect(requested).not.toHaveBeenCalled();

  // The handler gets the parsed value: the schema trims it.
  expect((await call({ reason: "  Sign in  " })).success).toBe(true);
  expect(requested).toHaveBeenCalledWith(session, { reason: "Sign in", itemId: "call-1" });
});

// The teammate tools that change setup keep their strict domain schemas: a misspelled field is
// refused, not silently dropped.
test("a teammate change with a misspelled field is refused", async () => {
  const requireTeammate = vi.fn();
  const handlers = new ToolHandlers({
    ctx: { log: { error: vi.fn() } },
    teammates: { requireBot: requireTeammate }, // vocabulary: allow
  } as unknown as ToolRegistryServices);
  const session = { isHelper: false, now: () => "now" } as unknown as RunSession;
  const response = await handlers.handle(session, {
    tool: "update_bot", // vocabulary: allow
    callId: "call-1",
    arguments: {
      bot_id: "00000000-0000-4000-8000-000000000001", // vocabulary: allow
      expected_revision: "r1",
      changes: { name: "Alex", rol: "Researcher" },
    },
  } as never);
  expect(response.success).toBe(false);
  expect(requireTeammate).not.toHaveBeenCalled();
});
