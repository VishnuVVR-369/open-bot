// The Codex thread a run continues: resume or fork the chat's thread, or start a fresh one when its
// tools, instructions or memory generation changed.
import type { CodexClient, v2 } from "@open-bot/agent";
import { teammateThreads, configurationRevision } from "@open-bot/db";
import { and, eq } from "drizzle-orm";
import type { Context } from "../../context";
import type { Teammate, Run } from "../../core/db-types";
import { providerFor } from "../../features/model-access";
import { DEVELOPER_INSTRUCTIONS } from "../../instructions";
import { errorMessage } from "../../logger";
import { approvalPolicy } from "../approval-policy";
import { toolsRevision } from "../tools-revision";

/**
 * `tools_version` of a thread this worker saved. A worker from before `tools_revision` writes its
 * TOOLS_VERSION there and leaves the revision as it was, so only this value vouches for it.
 */
const REVISED_THREAD = 0;

/** What choosing a thread reads from the session. */
export interface ThreadSession {
  readonly ctx: Context;
  readonly run: Run;
  readonly teammate: Teammate;
  readonly authMode: "plan" | "api_key";
  readonly apiKey: string | null;
  /** The AGENTS.md written for this run. */
  readonly agentsFile: string;
  readonly memoryGeneration: string;
  readonly workspace: string;
  readonly services: {
    connections: (
      teammateId: string,
    ) => Promise<{ key: string; config: NonNullable<v2.ThreadStartParams["config"]> }>;
    tools: { specs(): v2.DynamicToolSpec[] };
  };
}

/** The thread for this teammate and chat, on the access mode this run uses. */
export async function ensureThread(session: ThreadSession, client: CodexClient): Promise<string> {
  const { ctx, run, teammate } = session;
  const mode = session.authMode;
  // The services it may use through MCP come with the thread's config.
  const connected = await session.services.connections(teammate.id);
  // Codex reads AGENTS.md when a thread starts or forks, and a loaded thread keeps what it read.
  // So a new profile, approval rule or teammate forks the thread, like a change in connections.
  const configurationKey = configurationRevision({
    connections: connected.key,
    agents: session.agentsFile,
  });
  const access = providerFor(mode, session.apiKey, ctx.env);
  // Both add to the thread's config: the API key's provider, and the MCP servers. An empty set
  // is given too, so a fork after the last connection is removed doesn't keep its servers.
  const config = { ...access.config, mcp_servers: {}, ...connected.config };
  const provider = {
    ...access,
    ...(Object.keys(config).length ? { config } : {}),
  };
  // Threads keep the tools and instructions they started with; a change starts a fresh one.
  const dynamicTools = session.services.tools.specs();
  const revision = toolsRevision(DEVELOPER_INSTRUCTIONS, dynamicTools);
  const save = async (threadId: string, fresh: boolean) => {
    await ctx.db
      .insert(teammateThreads)
      .values({
        chatId: run.chatId,
        teammateId: teammate.id,
        codexThreadId: threadId,
        toolsVersion: REVISED_THREAD,
        toolsRevision: revision,
        memoryGeneration: session.memoryGeneration,
        authMode: mode,
        configurationKey,
      })
      .onConflictDoUpdate({
        target: [teammateThreads.chatId, teammateThreads.teammateId],
        // Memory generations fence old context; a fork is only allowed within the same generation.
        set: {
          codexThreadId: threadId,
          toolsVersion: REVISED_THREAD,
          toolsRevision: revision,
          memoryGeneration: session.memoryGeneration,
          authMode: mode,
          configurationKey,
          ...(fresh ? { profileSeenAt: new Date(), lessonsSeenAt: new Date() } : {}),
        },
      });
    ctx.codex.markLoaded(threadId);
    return threadId;
  };
  const [existing] = await ctx.db
    .select()
    .from(teammateThreads)
    .where(
      and(eq(teammateThreads.chatId, run.chatId), eq(teammateThreads.teammateId, teammate.id)),
    );
  if (
    existing &&
    existing.toolsVersion === REVISED_THREAD &&
    existing.toolsRevision === revision &&
    existing.memoryGeneration === session.memoryGeneration
  ) {
    try {
      if (existing.authMode !== mode || existing.configurationKey !== configurationKey) {
        // A thread keeps its provider, connections and AGENTS.md, so switching between the plan
        // and the API key, or a change in them, forks it, carrying the conversation over.
        const fork = await client.request("thread/fork", {
          threadId: existing.codexThreadId,
          cwd: session.workspace,
          ...provider,
        } as v2.ThreadForkParams);
        return await save(fork.thread.id, false);
      }
      if (ctx.codex.isLoaded(existing.codexThreadId)) return existing.codexThreadId;
      await client.request("thread/resume", {
        threadId: existing.codexThreadId,
        cwd: session.workspace,
        ...provider,
      } as v2.ThreadResumeParams);
      ctx.codex.markLoaded(existing.codexThreadId);
      return existing.codexThreadId;
    } catch (error) {
      ctx.log.warn("could not continue a thread, starting a new one", {
        threadId: existing.codexThreadId,
        error: errorMessage(error),
      });
    }
  }
  const response = await client.request("thread/start", {
    model: teammate.model,
    cwd: session.workspace,
    approvalPolicy: approvalPolicy(teammate),
    sandbox: "danger-full-access",
    developerInstructions: DEVELOPER_INSTRUCTIONS,
    dynamicTools,
    serviceName: "open-bot",
    ...provider,
  } as v2.ThreadStartParams);
  return save(response.thread.id, true);
}
