import { runs, schedules, triggers } from "@open-bot/db";
import {
  AUTONOMY_OPTIONS,
  createTeammateSchema,
  describeCron,
  updateTeammateSchema,
  type Autonomy,
  type TeammateCreationPlan,
  type TeammateProfile,
} from "@open-bot/domain";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Context } from "../../context";
import type { Teammate } from "../../core/db-types";
import type { SetupTitle, TeammateTargets } from "../../core/targets";
import type { RunSession } from "../../runs/session";
import type { ApprovalService } from "../approvals";
import { TeammateError, TeammateService } from "./service";

const assignmentSchema = z
  .object({
    teammate_id: z.string().uuid("Use a teammate id from list_teammates."),
    connection_id: z.string().uuid("Use a connection id from list_teammate_connections."),
    assigned: z.boolean(),
    expected_revision: z.string().min(1).max(128),
  })
  .strict();

type TargetArgs = { teammate_id?: string | undefined };

/**
 * What an "always allow" rule covers for each kind of teammate change, so allowing one covers the
 * rest of its kind. Autonomy and connection access have none: they are asked about every time.
 */
export const TEAMMATE_RULES = {
  create: "Create teammates",
  edit: "Edit teammates' profiles",
  setup: "Set up other teammates' skills and automations",
} as const;

function autonomyLabel(autonomy: Autonomy): string {
  return AUTONOMY_OPTIONS.find((option) => option.value === autonomy)?.label ?? autonomy;
}

function block(label: string, text: string): string {
  return `${label}:\n${text.trim() || "(none)"}`;
}

/** What the user reads before approving a new teammate: everything it will start with. */
export function creationDetail(plan: TeammateCreationPlan): string {
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

const PROFILE_LABELS: Record<keyof TeammateProfile, string> = {
  name: "Name",
  role: "Job",
  instructions: "Instructions",
  color: "Color",
  emoji: "Emoji",
  autonomy: "Autonomy",
};

/** The fields an edit changes, old and new. */
export function changesDetail(current: Teammate, changes: Partial<TeammateProfile>): string {
  const lines: string[] = [];
  let instructions: string | null = null;
  for (const [key, value] of Object.entries(changes) as [keyof TeammateProfile, string][]) {
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
    .filter(([key, value]) => key !== "teammate_id" && value !== undefined && value !== null)
    .map(([key, value]) => {
      const label = key.replaceAll("_", " ");
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return text.includes("\n") || text.length > 80 ? block(label, text) : `${label}: ${text}`;
    })
    .join("\n");
}

/** The tools teammates use to create and configure other teammates. */
export class TeammateTools implements TeammateTargets {
  constructor(
    private readonly ctx: Context,
    readonly teammates: TeammateService,
    private readonly approvals: ApprovalService,
  ) {}

  /** The teammate a tool acts on: `teammate_id` when given, otherwise the caller. */
  async target(session: RunSession, args: TargetArgs): Promise<Teammate> {
    return this.teammates.requireTeammate(args.teammate_id ?? session.teammate.id);
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
    if (session.isHelper) throw new TeammateError(403, "Helpers can't configure teammates.");
    const caller = await this.teammates.requireTeammate(session.teammate.id);
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
        throw new TeammateError(
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
      throw new TeammateError(409, "This run was stopped, so nothing was changed.");
    await this.teammates.requireTeammate(session.teammate.id);
  }

  /**
   * The teammate whose skills or automations a tool sets up. Setting up another teammate's asks
   * first, unless the caller works in full auto.
   */
  async setupTarget(
    session: RunSession,
    callId: string,
    tool: string,
    args: TargetArgs & { id?: string | undefined },
    title: SetupTitle,
  ): Promise<Teammate> {
    const target = await this.target(session, args);
    if (target.id === session.teammate.id) return target;
    const automation =
      typeof args.id === "string" ? await this.automationName(target.id, args.id) : "an automation";
    await this.authorize(session, callId, {
      tool,
      args,
      title: title({ teammate: target.name, automation }),
      detail: argumentsDetail(args),
      subject: TEAMMATE_RULES.setup,
    });
    // It may have been archived while the user decided.
    return this.teammates.requireTeammate(target.id);
  }

  private async automationName(teammateId: string, id: string): Promise<string> {
    if (!z.string().uuid().safeParse(id).success) return "an automation";
    const [row] = [
      ...(await this.ctx.db
        .select({ title: schedules.title })
        .from(schedules)
        .where(and(eq(schedules.id, id), eq(schedules.teammateId, teammateId)))),
      ...(await this.ctx.db
        .select({ title: triggers.title })
        .from(triggers)
        .where(and(eq(triggers.id, id), eq(triggers.teammateId, teammateId)))),
    ];
    return row ? `"${row.title}"` : "an automation";
  }

  async create(session: RunSession, callId: string, args: Record<string, unknown>) {
    const input = createTeammateSchema.parse(args);
    const plan = await this.teammates.plan(input);
    await this.teammates.checkPlan(plan);
    // More autonomy than "ask before risky actions" is the user's call, every time.
    const escalates = plan.profile.autonomy !== "risky";
    await this.authorize(session, callId, {
      tool: "create_teammate",
      args: input,
      title: `Create the teammate ${plan.profile.name}`,
      detail: creationDetail(plan),
      subject: escalates ? undefined : TEAMMATE_RULES.create,
      askEveryTime: escalates,
    });
    return this.teammates.create(plan, {
      kind: "bot",
      teammateId: session.teammate.id,
      runId: session.run.id,
    });
  }

  async update(session: RunSession, callId: string, args: Record<string, unknown>) {
    const input = updateTeammateSchema.parse(args);
    const current = await this.teammates.requireTeammate(input.teammate_id);
    if (TeammateService.revision(current) !== input.expected_revision)
      throw new TeammateError(
        409,
        "This teammate changed since you read it. Get it again, then retry.",
      );
    const escalates =
      input.changes.autonomy !== undefined && input.changes.autonomy !== current.autonomy;
    await this.authorize(session, callId, {
      tool: "update_teammate",
      args: input,
      title:
        current.id === session.teammate.id
          ? "Change your own profile"
          : `Change ${current.name}'s profile`,
      detail: changesDetail(current, input.changes),
      subject: escalates ? undefined : TEAMMATE_RULES.edit,
      askEveryTime: escalates,
    });
    try {
      const result = await this.teammates.update(
        input.teammate_id,
        input.changes,
        input.expected_revision,
      );
      return { result, name: input.changes.name ?? current.name };
    } catch (error) {
      if (error instanceof TeammateError && error.status === 409)
        throw new TeammateError(
          409,
          "This teammate changed while waiting for approval. Get it again and tell the user what changed instead of overwriting it.",
        );
      throw error;
    }
  }

  async setConnection(session: RunSession, callId: string, args: Record<string, unknown>) {
    const input = assignmentSchema.parse(args);
    const teammate = await this.teammates.requireTeammate(input.teammate_id);
    const connection = (await this.teammates.listConnections()).find(
      (row) => row.id === input.connection_id,
    );
    if (!connection) throw new TeammateError(404, "That connection no longer exists.");
    // Refuse before asking when it can't happen, and don't ask about a change that changes nothing.
    const change = TeammateService.assignment(
      connection,
      input.teammate_id,
      input.assigned,
      input.expected_revision,
    );
    if (change === "unchanged")
      return {
        teammateId: teammate.id,
        connectionId: connection.id,
        assigned: input.assigned,
        unchanged: input.assigned
          ? `${teammate.name} can already use ${connection.label}.`
          : `${teammate.name} already can't use ${connection.label}.`,
      };
    await this.authorize(session, callId, {
      tool: "set_teammate_connection",
      args: input,
      title: input.assigned
        ? `Let ${teammate.name} use ${connection.label}`
        : `Stop ${teammate.name} using ${connection.label}`,
      detail: input.assigned
        ? `${teammate.name} gets ${connection.label}'s tools from its next run, and can act through them within its autonomy.`
        : `${teammate.name} loses ${connection.label}'s tools from its next run.`,
      askEveryTime: true,
    });
    return this.teammates.setConnection(
      input.teammate_id,
      input.connection_id,
      input.assigned,
      input.expected_revision,
    );
  }
}
