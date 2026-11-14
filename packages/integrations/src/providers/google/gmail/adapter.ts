import { type ProviderError, type TokenSource } from "../../../core/http";
import { AccountToolError } from "../../../core/errors";
import { GmailApi, gmailProblem } from "./api";
import { namespace } from "../../../core/tool-spec";
import type {
  ActionRunner,
  IntegrationAdapter,
  IntegrationHost,
  ToolContext,
  ResolvedConnection,
  ToolResult,
} from "../../../core/adapter";
import { getAttachment, listLabels, readThread, search } from "./reads";
import { gmailRunner } from "./runner";
import { GMAIL_TOOLS, schemas } from "./tools";
import { createDraft, organize, sendDraft, updateDraft } from "./writes";

/** Gmail for teammates: reads answer directly; drafts, sending and labels are actions. */
export class GmailTools implements IntegrationAdapter {
  static readonly spec = namespace(
    "gmail",
    "The user's own Gmail, acting as them: search and read mail, write drafts, send drafts (with their approval), and organize. Not your own email (that's send_email).",
    GMAIL_TOOLS,
  );
  readonly kind = "gmail" as const;
  readonly runner: ActionRunner;

  constructor(private readonly host: IntegrationHost) {
    this.runner = gmailRunner(host);
  }

  problem(error: ProviderError): string {
    return gmailProblem(error);
  }

  async probe(_resolved: ResolvedConnection, tokens: TokenSource): Promise<string> {
    const profile = await new GmailApi(tokens, this.host.endpoints).get<{
      emailAddress: string;
      messagesTotal?: number;
    }>("/profile");
    return `Signed in as ${profile.emailAddress}`;
  }

  async call(tool: string, tc: ToolContext): Promise<ToolResult> {
    const api = new GmailApi(tc.tokens, this.host.endpoints);
    switch (tool) {
      case "search":
        return search(api, schemas.search.parse(tc.args));
      case "read_thread":
        return readThread(api, schemas.read_thread.parse(tc.args).thread_id);
      case "get_attachment":
        return getAttachment(api, tc, schemas.get_attachment.parse(tc.args));
      case "list_labels":
        return listLabels(api);
      case "create_draft":
        return {
          type: "action",
          action: await createDraft(api, tc, schemas.create_draft.parse(tc.args)),
        };
      case "update_draft":
        return {
          type: "action",
          action: await updateDraft(api, tc, schemas.update_draft.parse(tc.args)),
        };
      case "send_draft":
        return {
          type: "action",
          action: await sendDraft(api, tc, schemas.send_draft.parse(tc.args)),
        };
      case "organize":
        return {
          type: "action",
          action: await organize(api, schemas.organize.parse(tc.args)),
        };
      default:
        throw new AccountToolError(`Gmail has no tool ${tool}.`);
    }
  }
}
