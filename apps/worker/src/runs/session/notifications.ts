// Maps the Codex notifications of a session's turn onto timeline items, token usage and the
// turn's outcome.
import type { ServerNotification } from "@open-bot/agent";
import type { TimelineItem } from "@open-bot/domain";
import type { RunEventWriter } from "../events";
import { mapPlan, mapThreadItem } from "../mapper";
import type { Outcome, TokenUsage } from "./finalize";

const MAX_COMMAND_OUTPUT = 20_000;

/** What notification mapping reads and writes on the session. */
export interface NotificationSession {
  readonly items: Map<string, TimelineItem>;
  readonly writer: RunEventWriter;
  readonly usage: Record<"plan" | "api_key", TokenUsage>;
  readonly authMode: "plan" | "api_key";
  readonly turnId: string | null;
  readonly finish: ((outcome: Outcome) => void) | null;
  now(): string;
  putItem(item: TimelineItem): void;
}

export function onNotification(session: NotificationSession, notification: ServerNotification) {
  const now = session.now();
  switch (notification.method) {
    case "item/started": {
      const { item } = notification.params;
      if (item.type === "reasoning") return; // written once it has text
      const mapped = mapThreadItem(item, "started", now);
      if (mapped) session.putItem(mapped);
      return;
    }
    case "item/completed": {
      const { item } = notification.params;
      const mapped = mapThreadItem(item, "completed", now, session.items.get(item.id)?.startedAt);
      if (!mapped) return;
      if (mapped.kind === "command" && mapped.output.length > MAX_COMMAND_OUTPUT) {
        mapped.output = `…\n${mapped.output.slice(-MAX_COMMAND_OUTPUT)}`;
      }
      session.putItem(mapped);
      return;
    }
    case "item/agentMessage/delta":
      appendText(session, notification.params.itemId, notification.params.delta);
      return;
    case "item/reasoning/summaryTextDelta": {
      const { itemId, delta } = notification.params;
      if (!session.items.has(itemId)) {
        session.putItem({
          id: itemId,
          kind: "reasoning",
          text: "",
          status: "running",
          startedAt: now,
        });
      }
      appendText(session, itemId, delta);
      return;
    }
    case "item/reasoning/summaryPartAdded": {
      const item = session.items.get(notification.params.itemId);
      if (item?.kind === "reasoning" && item.text) appendText(session, item.id, "\n\n");
      return;
    }
    case "item/commandExecution/outputDelta": {
      const item = session.items.get(notification.params.itemId);
      if (item?.kind === "command" && item.output.length < MAX_COMMAND_OUTPUT) {
        item.output += notification.params.delta;
        session.writer.delta(item.id, notification.params.delta);
      }
      return;
    }
    case "turn/plan/updated":
      if (notification.params.plan.length > 0) {
        session.putItem(
          mapPlan(notification.params.plan, `plan-${notification.params.turnId}`, now),
        );
      }
      return;
    case "thread/tokenUsage/updated": {
      const last = notification.params.tokenUsage.last;
      const usage = session.usage[session.authMode];
      usage.inputTokens += last.inputTokens;
      usage.cachedInputTokens += last.cachedInputTokens;
      usage.outputTokens += last.outputTokens;
      return;
    }
    case "turn/completed": {
      const { turn } = notification.params;
      if (turn.id !== session.turnId) return;
      const info = turn.error?.codexErrorInfo;
      if (turn.status === "completed") session.finish?.({ status: "completed" });
      else if (turn.status === "interrupted") session.finish?.({ status: "interrupted" });
      else {
        const status =
          typeof info === "object" && info !== null && "httpConnectionFailed" in info
            ? (info as { httpConnectionFailed: { httpStatusCode: number | null } })
                .httpConnectionFailed.httpStatusCode
            : null;
        session.finish?.({
          status: "failed",
          error: turn.error?.message ?? "The turn failed.",
          usageLimit: info === "usageLimitExceeded",
          unauthorized: info === "unauthorized" || status === 401,
        });
      }
      return;
    }
    default:
      return;
  }
}

function appendText(session: NotificationSession, itemId: string, delta: string) {
  const item = session.items.get(itemId);
  if (item && (item.kind === "message" || item.kind === "reasoning")) {
    item.text += delta;
    session.writer.delta(itemId, delta);
  }
}
