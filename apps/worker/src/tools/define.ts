// What an agent tool is: one definition holds its name, description, input schema and handler.
// Codex sees the JSON schema derived from `input`, so the two never drift (see definitions.ts).
import type { v2 } from "@open-bot/agent";
import type { ToolItem } from "@open-bot/domain";
import { z } from "zod";
import type { Context } from "../context";
import type { AccountTools } from "../accounts/tools";
import type { RunSession } from "../runs/session";
import type { ApprovalService } from "../services/approvals";
import type { BotService } from "../services/bots";
import type { EmailService } from "../services/email";
import type { MemoryCoordinator } from "../services/memory";
import type { PageService } from "../services/pages";
import type { ScheduleService } from "../services/schedules";
import type { SkillService } from "../services/skills";
import type { SwarmService } from "../services/swarms";
import type { TakeoverService } from "../services/takeovers";
import type { TaskService } from "../services/tasks";
import type { TriggerService } from "../services/triggers";
import type { VaultService } from "../services/vault";
import type { BotTools } from "./bots";

export type ToolResponse = v2.DynamicToolCallResponse;

/** The services tools use, by name. */
export interface ToolServices {
  ctx: Context;
  approvals: ApprovalService;
  takeovers: TakeoverService;
  schedules: ScheduleService;
  skills: SkillService;
  triggers: TriggerService;
  tasks: TaskService;
  vault: VaultService;
  swarms: SwarmService;
  email: EmailService;
  memory: MemoryCoordinator;
  teammates: BotService;
  pages: PageService;
  accounts: AccountTools;
}

/** What a handler gets: the services, plus the teammate tools that resolve and authorize targets. */
export interface ToolDeps extends ToolServices {
  botTools: BotTools;
}

/** One call of a tool, in a teammate's run. */
export interface ToolCall {
  session: RunSession;
  callId: string;
  /** The arguments as Codex sent them. */
  args: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** The arguments, as an object schema. Codex is offered its JSON schema. */
  input: z.ZodObject;
  /** Whether swarm helpers may call it. Helpers do their one part; they don't reach out. */
  helpers: "allowed" | "forbidden";
  handle(call: ToolCall, deps: ToolDeps): Promise<ToolResponse>;
}

export function defineTool(definition: ToolDefinition): ToolDefinition {
  return definition;
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
 * doesn't say (the `$schema` URL, the pattern behind `format: "uuid"`, the safe-integer bounds
 * of `.int()`), and with each object closed to properties it doesn't list.
 */
export function inputJsonSchema(input: z.ZodObject): JsonSchema {
  const { $schema: _, ...schema } = z.toJSONSchema(input, {
    io: "input",
    unrepresentable: "throw",
  }) as Record<string, unknown>;
  const tidy = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(tidy);
    const record = node as Record<string, unknown>;
    if (record.format === "uuid") delete record.pattern;
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
export function toolSpec(definition: ToolDefinition): v2.DynamicToolSpec {
  return {
    type: "function",
    name: definition.name,
    description: definition.description,
    inputSchema: inputJsonSchema(definition.input),
  };
}
