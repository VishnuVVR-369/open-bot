// Runs the dynamic tools that Codex calls back into the worker for: finds the tool's definition in
// the catalog and runs its handler. The definitions live with their feature (see definitions.ts).
import type { v2 } from "@open-bot/agent";
import { isAccountNamespace } from "@open-bot/integrations/adapters";
import { z } from "zod";
import { errorMessage } from "../logger";
import type { RunSession, SessionTools } from "../runs/session";
import { WorkerError } from "../core/errors";
import { BotTools } from "../features/teammates";
import { toolNamed, toolsFor } from "./definitions";
import { parseArgs, text, type ToolResponse } from "../core/tool";
import type { ToolDeps, ToolRegistryServices } from "./dependencies";

export class ToolHandlers implements SessionTools {
  private readonly deps: ToolDeps;

  constructor(services: ToolRegistryServices) {
    this.deps = {
      ...services,
      botTools: new BotTools(services.ctx, services.teammates, services.approvals),
    };
  }

  /** The tools a new thread is given. */
  specs(): v2.DynamicToolSpec[] {
    return toolsFor();
  }

  async handle(session: RunSession, params: v2.DynamicToolCallParams): Promise<ToolResponse> {
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const { ctx, memory, accounts } = this.deps;
    try {
      if (
        session.memoryGeneration &&
        (await memory.store.generation(session.bot.id)) !== session.memoryGeneration
      ) {
        // A memory tool may have just changed this run's memory. Recalled context must be rebuilt before further effects.
        await session.interrupt();
        return text(
          "Saved memory changed. This task stopped so it cannot use stale memory; retry with current memory.",
          false,
        );
      }
      // The user's accounts (gmail.*, calendar.*, notion.*, …), which check their own access.
      if (params.namespace && isAccountNamespace(params.namespace))
        return await accounts.handle(session, params);
      const tool = toolNamed(params.tool);
      if (!tool) return text(`Unknown tool ${params.tool}`, false);
      // A helper does its one part; it doesn't reach out to the user or the team.
      if (session.isHelper && tool.helpers === "forbidden")
        return text(
          "Helpers can't do that. Finish your part, and say in your result what's needed.",
          false,
        );
      return await tool.handle(
        { session, callId: params.callId, args: parseArgs(tool, args), raw: args },
        this.deps,
      );
    } catch (error) {
      // A request the teammate can fix itself, or tell the owner about: said plainly.
      if (error instanceof WorkerError) return text(error.message, false);
      if (error instanceof z.ZodError)
        return text(
          error.issues
            .map(
              (issue) => `${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`,
            )
            .join("; "),
          false,
        );
      ctx.log.error("tool failed", { tool: params.tool, error: errorMessage(error) });
      return text(`The tool failed: ${errorMessage(error)}`, false);
    }
  }
}
