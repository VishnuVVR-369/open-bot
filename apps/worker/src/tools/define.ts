// The services every agent tool can use. A feature's tools (under features/) ask only for their
// own; the tools still here take all of them, until their feature moves.
import type { z } from "zod";
import type { Context } from "../context";
import type { AccountTools } from "../accounts/tools";
import { defineTool as defineFeatureTool, type ToolDefinition } from "../core/tool";
import type { TaskService } from "../features/tasks";
import type { ApprovalService } from "../features/approvals";
import type { BotService } from "../features/teammates";
import type { EmailService } from "../services/email";
import type { MemoryCoordinator } from "../features/memory";
import type { PageService } from "../features/pages";
import type { ScheduleService, TriggerService } from "../features/automations";
import type { SkillService } from "../services/skills";
import type { SwarmService } from "../services/swarms";
import type { TakeoverService } from "../features/screens";
import type { VaultService } from "../services/vault";
import type { BotTools } from "../features/teammates";

export {
  inputJsonSchema,
  parseArgs,
  text,
  toolItem,
  toolSpec,
  type ToolCall,
  type ToolDefinition,
  type ToolResponse,
} from "../core/tool";

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

/** A tool of any input, as the catalog holds it: given every service. */
export type AnyTool = ToolDefinition<z.ZodObject, ToolDeps>;

/** A tool that takes every service. */
export function defineTool<Input extends z.ZodObject>(
  definition: ToolDefinition<Input, ToolDeps>,
): AnyTool {
  return defineFeatureTool(definition);
}
