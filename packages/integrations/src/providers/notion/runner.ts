// Runs approved Notion changes for the executor, follows Notion's background tasks, and
// remembers what teammates made.
import { accountResources } from "@open-bot/db";
import { notionParent } from "./effects";
import type { ActionOutcome, ActionRunner, IntegrationHost } from "../../core/adapter";
import { type NotionMcp } from "./mcp";
import { asyncTask, createdIds, excerpt, resultData, resultText, type McpResult } from "./results";

const ASYNC_TASK_TOOL = "notion-get-async-task";

/** Runs Notion actions for the executor. Nothing here is ever retried blindly. */
export function notionRunner(host: IntegrationHost, mcp: NotionMcp): ActionRunner {
  return {
    execute: async (action, tokens, resolved) => {
      const request = action.request as { notionTool: string; args: Record<string, unknown> };
      const result = await mcp.callTool(
        resolved.account.id,
        tokens,
        request.notionTool,
        request.args,
        "write",
      );
      return outcome(result);
    },
    // Notion has no way to make a write safe to repeat, so an interrupted one stays unknown.
    reconcile: async () => null,
    poll: async (action, tokens, resolved) => {
      const taskId = String((action.providerRef as { taskId?: unknown } | null)?.taskId ?? "");
      const result = await mcp.callTool(
        resolved.account.id,
        tokens,
        ASYNC_TASK_TOOL,
        { task_id: taskId },
        "read",
      );
      if (result.isError)
        return { status: "failed", error: `Notion: ${excerpt(resultText(result), 500)}` };
      const data = resultData(result) as {
        status?: string;
        result?: unknown;
        error?: unknown;
        poll_after_seconds?: number;
      } | null;
      if (data?.status === "succeeded")
        return {
          status: "done",
          message: `Done. ${excerpt(data.result, 2000)}`,
          result: { data: data.result as unknown } as Record<string, unknown>,
          providerRef: { taskId },
        };
      if (data?.status === "failed")
        return {
          status: "failed",
          error: `Notion: ${excerpt(data.error, 500) || "the task failed."}`,
        };
      return {
        status: "waiting",
        providerRef: { taskId },
        checkAfterMs: Math.min(Math.max((data?.poll_after_seconds ?? 3) * 1000, 1000), 30_000),
      };
    },
    done: async (action, outcome) => {
      const tool = action.tool.replace(/^notion\./, "");
      if ((tool !== "create_pages" && tool !== "create_database") || !action.connectionId) return;
      const request = action.request as { args: Record<string, unknown> };
      const parent = notionParent(request.args.parent);
      const ids = createdIds(outcome.result?.data ?? outcome.result);
      if (ids.length === 0) return;
      await host.db
        .insert(accountResources)
        .values(
          ids.map((externalId) => ({
            connectionId: action.connectionId!,
            externalId,
            kind: tool === "create_pages" ? ("notion_page" as const) : ("notion_database" as const),
            private: parent === null,
            actionId: action.id,
          })),
        )
        .onConflictDoNothing();
    },
  };
}

function outcome(result: McpResult): ActionOutcome {
  const text = resultText(result);
  if (result.isError)
    return {
      status: "failed",
      error: `Notion: ${excerpt(text, 1000) || "it refused the request."}`,
    };
  const data = resultData(result);
  const task = asyncTask(data);
  if (task)
    return {
      status: "waiting",
      providerRef: { taskId: task.id },
      checkAfterMs: task.pollAfterMs,
    };
  return {
    status: "done",
    message: `Done. ${excerpt(text, 2000)}`,
    result: { data: (data ?? text) as unknown } as Record<string, unknown>,
  };
}
