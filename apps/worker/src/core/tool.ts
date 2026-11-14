// What an agent tool is: one definition holds its name, description, input schema and handler.
// Codex sees the JSON schema derived from `input`, so the two never drift (see tools/definitions.ts).
import type { v2 } from "@open-bot/agent";
import type { ToolItem } from "@open-bot/domain";
import { z } from "zod";
import type { RunSession } from "../runs/session";

export type ToolResponse = v2.DynamicToolCallResponse;

/** One call of a tool, in a teammate's run. */
export interface ToolCall<Args = Record<string, unknown>> {
  session: RunSession;
  callId: string;
  /** The arguments, parsed with the tool's input schema. */
  args: Args;
  /** The arguments as Codex sent them, for the chat's timeline. */
  raw: Record<string, unknown>;
}

/**
 * An agent tool. `Deps` is what its handler uses, by name: a feature's tools ask only for that
 * feature's services, and the catalog hands every tool all of them.
 */
export interface ToolDefinition<Input extends z.ZodObject = z.ZodObject, Deps = unknown> {
  name: string;
  description: string;
  /** The arguments, as an object schema. Codex is offered its JSON schema, and calls are parsed with it. */
  input: Input;
  /** Whether swarm helpers may call it. Helpers do their one part; they don't reach out. */
  helpers: "allowed" | "forbidden";
  // A property, not a method: a method's parameters are checked both ways, so a handler asking for
  // a dependency the catalog doesn't give would still fit (core/tool.test.ts).
  handle: (call: ToolCall<z.output<Input>>, deps: Deps) => Promise<ToolResponse>;
}

export function defineTool<Input extends z.ZodObject, Deps>(
  definition: ToolDefinition<Input, Deps>,
): ToolDefinition<z.ZodObject, Deps> {
  return definition as unknown as ToolDefinition<z.ZodObject, Deps>;
}

/**
 * Parses a call's arguments with the tool's input schema, which is the whole contract: a field
 * Codex sends as null is refused like any other wrong type, never read as left out, and an argument
 * the tool doesn't take is refused, never dropped. A dropped target id would make the call act on
 * the caller, so a misspelled or renamed one (such as `teammate_id` from a newer worker's stored
 * approval) must fail instead. An input made with `z.looseObject()` lets other arguments through
 * to a handler that reads them from `raw`.
 */
export function parseArgs(
  tool: Pick<ToolDefinition, "input">,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  return (tool.input.def.catchall ? tool.input : tool.input.strict()).parse(raw);
}

/** A plain text reply to the teammate. */
export function text(message: string, success = true): ToolResponse {
  return { success, contentItems: [{ type: "inputText", text: message }] };
}

/** A running tool step for the chat's timeline. */
export function toolItem(
  callId: string,
  name: string,
  label: string,
  args: unknown,
  startedAt: string,
): ToolItem {
  return { id: callId, kind: "tool", name, label, args, status: "running", startedAt };
}

type JsonSchema = v2.DynamicToolFunctionSpec["inputSchema"];

/**
 * The JSON schema Codex is offered for `input`: zod's, without what zod adds that a tool spec
 * doesn't say (the `$schema` URL, the pattern behind `format: "uuid"` or `"email"`, the safe-integer bounds
 * of `.int()`), and with each object closed to properties it doesn't list.
 */
export function inputJsonSchema(input: z.ZodObject): JsonSchema {
  // Closed even when the handler takes more (`z.looseObject()`): Codex is offered only what it lists.
  const { $schema: _, ...schema } = z.toJSONSchema(input.strict(), {
    io: "input",
    unrepresentable: "throw",
  }) as Record<string, unknown>;
  const tidy = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(tidy);
    const record = node as Record<string, unknown>;
    if (record.format === "uuid" || record.format === "email") delete record.pattern;
    if (record.type === "integer") {
      if (record.minimum === Number.MIN_SAFE_INTEGER) delete record.minimum;
      if (record.maximum === Number.MAX_SAFE_INTEGER) delete record.maximum;
    }
    // A fixed-shape object is closed; a record keeps the schema it gives its values.
    if (record.type === "object" && record.additionalProperties === undefined)
      record.additionalProperties = false;
    Object.values(record).forEach(tidy);
  };
  tidy(schema);
  return { required: [], ...schema };
}

/** The spec Codex is given for a tool. */
export function toolSpec(
  definition: Pick<ToolDefinition, "name" | "description" | "input">,
): v2.DynamicToolSpec {
  return {
    type: "function",
    name: definition.name,
    description: definition.description,
    inputSchema: inputJsonSchema(definition.input),
  };
}
