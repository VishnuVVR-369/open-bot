// The registry composes feature dependencies here; each feature declares only what its tools use.
import type { z } from "zod";
import type { Context } from "../context";
import type { AccountTools } from "../features/integrations";
import type { ToolDefinition } from "../core/tool";
import type { TaskService } from "../features/tasks";
import type { ApprovalService } from "../features/approvals";
import type { BotService, BotTools } from "../features/teammates";
import type { EmailService } from "../features/email";
import type { MemoryCoordinator } from "../features/memory";
import type { PageService } from "../features/pages";
import type { ScheduleService, TriggerService } from "../features/automations";
import type { SkillService } from "../features/skills";
import type { SwarmService } from "../features/teamwork";
import type { TakeoverService } from "../features/screens";
import type { VaultService } from "../features/vault";

/** The services injected into the tool registry at startup. */
export interface ToolRegistryServices {
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
export interface ToolDeps extends ToolRegistryServices {
  botTools: BotTools;
}

/** A tool of any input, as the catalog holds it: given every service. */
export type AnyTool = ToolDefinition<z.ZodObject, ToolDeps>;
