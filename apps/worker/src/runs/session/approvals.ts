// Answers the requests Codex sends during a turn: agent tool calls, and native approvals for
// commands and file changes.
import type { ServerRequest, v2 } from "@open-bot/agent";
import { type NativeApprovalKind, shellScript, type TimelineItem } from "@open-bot/domain";

/** What answering a server request reads from the session `S`, which the services are handed. */
export interface RequestSession<S> {
  readonly items: Map<string, TimelineItem>;
  readonly services: {
    tools: {
      handle(session: S, params: v2.DynamicToolCallParams): Promise<v2.DynamicToolCallResponse>;
    };
    requestNativeApproval: (
      session: S,
      input: {
        kind: NativeApprovalKind;
        title: string;
        detail: string;
        itemId: string;
        subject?: string;
      },
    ) => Promise<boolean>;
  };
}

export async function onServerRequest<S extends RequestSession<S>>(
  session: S,
  request: ServerRequest,
): Promise<unknown> {
  switch (request.method) {
    case "item/tool/call":
      return session.services.tools.handle(session, request.params);
    case "item/commandExecution/requestApproval": {
      const params = request.params;
      const command = params.command ?? "a command";
      const script = shellScript(command);
      const approved = await session.services.requestNativeApproval(session, {
        kind: "command",
        subject: command,
        title: `Run \`${script.length > 80 ? `${script.slice(0, 80)}…` : script}\``,
        detail: [params.reason, `$ ${script}`, params.cwd ? `in ${params.cwd}` : null]
          .filter(Boolean)
          .join("\n"),
        itemId: `approval-${params.itemId}-${params.approvalId ?? ""}`,
      });
      return { decision: approved ? "accept" : "decline" };
    }
    case "item/fileChange/requestApproval": {
      const params = request.params;
      const item = session.items.get(params.itemId);
      const paths = item?.kind === "file_change" ? item.changes.map((change) => change.path) : [];
      const approved = await session.services.requestNativeApproval(session, {
        kind: "file_change",
        title: paths.length
          ? `Change ${paths.length === 1 ? paths[0] : `${paths.length} files`}`
          : "Change files",
        detail: [
          params.reason,
          ...(item?.kind === "file_change" ? item.changes.map((c) => c.diff) : []),
        ]
          .filter(Boolean)
          .join("\n\n"),
        itemId: `approval-${params.itemId}`,
      });
      return { decision: approved ? "accept" : "decline" };
    }
    case "item/tool/requestUserInput":
      return { answers: {} };
    case "mcpServer/elicitation/request":
      return { action: "decline", content: null, _meta: null };
    default:
      throw new Error(`open-bot doesn't handle ${request.method}`);
  }
}
