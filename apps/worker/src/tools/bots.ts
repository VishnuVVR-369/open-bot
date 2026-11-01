import type { v2 } from "@open-bot/agent";
import { runs, schedules, triggers } from "@open-bot/db";
import {
  AUTONOMY_OPTIONS,
  createBotSchema,
  describeCron,
  updateBotSchema,
  type Autonomy,
  type BotCreationPlan,
  type BotProfile,
} from "@open-bot/shared";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Context } from "../context";
import type { Bot, RunSession } from "../runs/session";
import type { ApprovalService } from "../services/approvals";
import { BotError, BotService } from "../services/bots";

const botId = z.string().uuid("Use a teammate id from list_bots.");

const assignmentSchema = z
  .object({
    bot_id: botId,
    connection_id: z.string().uuid("Use a connection id from list_bot_connections."),
    assigned: z.boolean(),
    expected_revision: z.string().min(1).max(128),
  })
  .strict();

export const BOT_TOOL_NAMES = new Set([
  "list_bots",
  "get_bot",
  "list_bot_templates",
  "create_bot",
  "update_bot",
  "list_bot_connections",
  "set_bot_connection",
]);

/**
 * What an "always allow" rule covers for each kind of teammate change, so allowing one covers the
 * rest of its kind. Autonomy and connection access have none: they are asked about every time.
 */
export const TEAMMATE_RULES = {
  create: "Create teammates",
  edit: "Edit teammates' profiles",
  setup: "Set up other teammates' skills and automations",
} as const;

/** The tools that set up a teammate's skills and automations, as approval titles. */
const SETUP_TITLES: Record<string, (args: Record<string, unknown>, name: string) => string> = {
  schedule_task: (args, name) => `Schedule "${String(args.title ?? "")}" for ${name}`,
  save_skill: (args, name) => `Save the /${String(args.name ?? "")} skill for ${name}`,
  watch_page: (args, name) => `Watch ${String(args.url ?? "a page")} for ${name}`,
  create_webhook: (args, name) => `Create the webhook "${String(args.title ?? "")}" for ${name}`,
  update_automation: (args, name) => `Change ${String(args.automation)} for ${name}`,
  cancel_automation: (args, name) => `Delete ${String(args.automation)} for ${name}`,
};

function autonomyLabel(autonomy: Autonomy): string {
  return AUTONOMY_OPTIONS.find((option) => option.value === autonomy)?.label ?? autonomy;
}

function block(label: string, text: string): string {
  return `${label}:\n${text.trim() || "(none)"}`;
}

/** What the user reads before approving a new teammate: everything it will start with. */
export function creationDetail(plan: BotCreationPlan): string {
  const { profile } = plan;
  // The short facts first, so they show without scrolling past long instructions.
  const parts = [
    `${profile.emoji ? `${profile.emoji} ` : ""}${profile.name}, ${profile.role}\nAutonomy: ${autonomyLabel(profile.autonomy)}`,
  ];
  if (plan.skills.length)
    parts.push(
      block(
        "Skills",
        plan.skills.map((skill) => `- /${skill.name}: ${skill.description}`).join("\n"),
      ),
    );
  if (plan.schedules.length)
    parts.push(
      block(
        "Schedules",
        plan.schedules
          .map(
            (schedule) =>
              `- ${schedule.title}: ${schedule.cron ? describeCron(schedule.cron) : `once, ${schedule.at}`}`,
          )
          .join("\n"),
      ),
    );
  parts.push(block("Instructions", profile.instructions));
  return parts.join("\n\n");
}

const PROFILE_LABELS: Record<keyof BotProfile, string> = {
  name: "Name",
  role: "Job",
  instructions: "Instructions",
  color: "Color",
  emoji: "Emoji",
  autonomy: "Autonomy",
};

/** The fields an edit changes, old and new. */
export function changesDetail(current: Bot, changes: Partial<BotProfile>): string {
  const lines: string[] = [];
  let instructions: string | null = null;
  for (const [key, value] of Object.entries(changes) as [keyof BotProfile, string][]) {
    if (key === "instructions") instructions = value;
    else if (key === "autonomy")
      lines.push(
        `Autonomy: ${autonomyLabel(current.autonomy)} → ${autonomyLabel(value as Autonomy)}`,
      );
    else lines.push(`${PROFILE_LABELS[key]}: ${current[key] || "(none)"} → ${value || "(none)"}`);
  }
  if (instructions !== null) lines.push(`\n${block("New instructions", instructions)}`);
  return lines.join("\n").trim();
}

/** A tool call's arguments as readable lines, for approving a change to another teammate. */
function argumentsDetail(args: Record<string, unknown>): string {
  return Object.entries(args)
    .filter(([key, value]) => key !== "bot_id" && value !== undefined && value !== null)
    .map(([key, value]) => {
      const label = key.replaceAll("_", " ");
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return text.includes("\n") || text.length > 80 ? block(label, text) : `${label}: ${text}`;
    })
    .join("\n");
}

/** The tools teammates use to create and configure other teammates. */
export class BotTools {
  constructor(
    private readonly ctx: Context,
    readonly bots: BotService,
    private readonly approvals: ApprovalService,
  ) {}

  /** The teammate a tool acts on: `bot_id` when given, otherwise the caller. */
  async target(session: RunSession, args: Record<string, unknown>): Promise<Bot> {
    return this.bots.requireBot(
      args.bot_id === undefined ? session.bot.id : botId.parse(args.bot_id),
    );
  }

  /**
   * Asks the user when the caller's autonomy says so (always, with `askEveryTime`), and makes
   * sure nothing changed meanwhile that should stop the change: a cancelled run, or a caller
   * that was archived or had its autonomy lowered.
   */
  async authorize(
    session: RunSession,
    callId: string,
    request: {
      tool: string;
      args: Record<string, unknown>;
      title: string;
      detail: string;
      subject?: string;
      askEveryTime?: boolean;
    },
  ): Promise<void> {
    if (session.isHelper) throw new BotError(403, "Helpers can't configure teammates.");
    const caller = await this.bots.requireBot(session.bot.id);
    if (request.askEveryTime || caller.autonomy !== "full") {
      const decision = await this.approvals.requestAction(session, {
        title: request.title,
        detail: request.detail,
        itemId: `${callId}-approval`,
        subject: request.subject,
        askEveryTime: request.askEveryTime,
        operation: { tool: request.tool, arguments: request.args },
      });
      if (decision !== "approved")
        throw new BotError(
          403,
          decision === "pending"
            ? "Waiting for the user's approval. End your turn; the decision arrives as a new message."
            : "The user denied this change. Don't make it, and don't try another way.",
        );
    }
    // An approval may arrive after the run was stopped; it must not bring the change back.
    const [run] = await this.ctx.db
      .select({ cancelRequestedAt: runs.cancelRequestedAt })
      .from(runs)
      .where(eq(runs.id, session.run.id));
    if (!run || run.cancelRequestedAt)
      throw new BotError(409, "This run was stopped, so nothing was changed.");
    await this.bots.requireBot(session.bot.id);
  }

  /**
   * The teammate whose skills or automations a tool sets up. Setting up another teammate's asks
   * first, unless the caller works in full auto.
   */
  async setupTarget(
    session: RunSession,
    callId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<Bot> {
    const target = await this.target(session, args);
    if (target.id === session.bot.id) return target;
    const named =
      typeof args.id === "string"
        ? { ...args, automation: await this.automationName(target.id, args.id) }
        : args;
    await this.authorize(session, callId, {
      tool,
      args,
      title: SETUP_TITLES[tool]?.(named, target.name) ?? `${tool} for ${target.name}`,
      detail: argumentsDetail(args),
      subject: TEAMMATE_RULES.setup,
    });
    // It may have been archived while the user decided.
    return this.bots.requireBot(target.id);
  }

  private async automationName(botId: string, id: string): Promise<string> {
    if (!z.string().uuid().safeParse(id).success) return "an automation";
    const [row] = [
      ...(await this.ctx.db
        .select({ title: schedules.title })
        .from(schedules)
        .where(and(eq(schedules.id, id), eq(schedules.botId, botId)))),
      ...(await this.ctx.db
        .select({ title: triggers.title })
        .from(triggers)
        .where(and(eq(triggers.id, id), eq(triggers.botId, botId)))),
    ];
    return row ? `"${row.title}"` : "an automation";
  }

  /** Runs a teammate tool. Changes come with a label for the chat's timeline. */
  async handle(
    session: RunSession,
    params: v2.DynamicToolCallParams,
  ): Promise<{ result: unknown; label?: string }> {
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    switch (params.tool) {
      case "list_bots":
        return { result: await this.bots.list() };
      case "get_bot":
        return { result: await this.bots.get(botId.parse(args.bot_id)) };
      case "list_bot_templates":
        return { result: this.bots.templates() };
      case "list_bot_connections":
        return { result: await this.bots.listConnections() };
      case "create_bot": {
        const result = await this.create(session, params.callId, args);
        return { result, label: `Created the teammate ${result.name}` };
      }
      case "update_bot": {
        const { result, name } = await this.update(session, params.callId, args);
        return { result, label: `Updated ${name}'s profile` };
      }
      case "set_bot_connection": {
        const result = await this.setConnection(session, params.callId, args);
        return { result, label: "unchanged" in result ? undefined : "Changed a teammate's access" };
      }
      default:
        throw new BotError(400, `Unknown tool ${params.tool}.`);
    }
  }

  private async create(session: RunSession, callId: string, args: Record<string, unknown>) {
    const input = createBotSchema.parse(args);
    const plan = await this.bots.plan(input);
    await this.bots.checkPlan(plan);
    // More autonomy than "ask before risky actions" is the user's call, every time.
    const escalates = plan.profile.autonomy !== "risky";
    await this.authorize(session, callId, {
      tool: "create_bot",
      args: input,
      title: `Create the teammate ${plan.profile.name}`,
      detail: creationDetail(plan),
      subject: escalates ? undefined : TEAMMATE_RULES.create,
      askEveryTime: escalates,
    });
    return this.bots.create(plan, { kind: "bot", botId: session.bot.id, runId: session.run.id });
  }

  private async update(session: RunSession, callId: string, args: Record<string, unknown>) {
    const input = updateBotSchema.parse(args);
    const current = await this.bots.requireBot(input.bot_id);
    if (BotService.revision(current) !== input.expected_revision)
      throw new BotError(409, "This teammate changed since you read it. Get it again, then retry.");
    const escalates =
      input.changes.autonomy !== undefined && input.changes.autonomy !== current.autonomy;
    await this.authorize(session, callId, {
      tool: "update_bot",
      args: input,
      title:
        current.id === session.bot.id
          ? "Change your own profile"
          : `Change ${current.name}'s profile`,
      detail: changesDetail(current, input.changes),
      subject: escalates ? undefined : TEAMMATE_RULES.edit,
      askEveryTime: escalates,
    });
    try {
      const result = await this.bots.update(input.bot_id, input.changes, input.expected_revision);
      return { result, name: input.changes.name ?? current.name };
    } catch (error) {
      if (error instanceof BotError && error.status === 409)
        throw new BotError(
          409,
          "This teammate changed while waiting for approval. Get it again and tell the user what changed instead of overwriting it.",
        );
      throw error;
    }
  }

  private async setConnection(session: RunSession, callId: string, args: Record<string, unknown>) {
    const input = assignmentSchema.parse(args);
    const bot = await this.bots.requireBot(input.bot_id);
    const connection = (await this.bots.listConnections()).find(
      (row) => row.id === input.connection_id,
    );
    if (!connection) throw new BotError(404, "That connection no longer exists.");
    // Refuse before asking when it can't happen, and don't ask about a change that changes nothing.
    const change = BotService.assignment(
      connection,
      input.bot_id,
      input.assigned,
      input.expected_revision,
    );
    if (change === "unchanged")
      return {
        botId: bot.id,
        connectionId: connection.id,
        assigned: input.assigned,
        unchanged: input.assigned
          ? `${bot.name} can already use ${connection.label}.`
          : `${bot.name} already can't use ${connection.label}.`,
      };
    await this.authorize(session, callId, {
      tool: "set_bot_connection",
      args: input,
      title: input.assigned
        ? `Let ${bot.name} use ${connection.label}`
        : `Stop ${bot.name} using ${connection.label}`,
      detail: input.assigned
        ? `${bot.name} gets ${connection.label}'s tools from its next run, and can act through them within its autonomy.`
        : `${bot.name} loses ${connection.label}'s tools from its next run.`,
      askEveryTime: true,
    });
    return this.bots.setConnection(
      input.bot_id,
      input.connection_id,
      input.assigned,
      input.expected_revision,
    );
  }
}
