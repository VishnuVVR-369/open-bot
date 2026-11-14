import { AccountToolError } from "../../core/errors";
import { ProviderError, type TokenSource } from "../../core/http";
import { namespace } from "../../core/tool-spec";
import type {
  ActionRunner,
  IntegrationAdapter,
  ToolContext,
  IntegrationHost,
  ResolvedConnection,
  ToolResult,
} from "../../core/adapter";
import { messageOf, NotionMcp, type OpenClient } from "./mcp";
import { read } from "./reads";
import { notionRunner } from "./runner";
import { NOTION_TOOL_NAMES, NOTION_TOOLS, READS } from "./tools";
import { prepare } from "./writes";

/**
 * Notion for teammates, through Notion's hosted MCP server. The worker is the MCP client and holds
 * the token; teammates get a curated set of Notion's tools, checked and classified here.
 */
export class NotionTools implements IntegrationAdapter {
  static readonly spec = namespace(
    "notion",
    "The user's Notion workspace: search and read pages and databases, and write pages. Writes others can see ask the user first.",
    NOTION_TOOLS,
  );
  readonly kind = "notion" as const;
  private readonly mcp: NotionMcp;
  readonly runner: ActionRunner;

  constructor(private readonly host: IntegrationHost) {
    this.mcp = new NotionMcp(host);
    this.runner = notionRunner(host, this.mcp);
  }

  /** Stops the idle sweep and closes every open Notion session. */
  stop(): Promise<void> {
    return this.mcp.stop();
  }

  /**
   * Proves the connection works, for Settings' Test: Notion's tools are listed, and every one
   * open-bot forwards has to be among them.
   */
  async probe(resolved: ResolvedConnection, tokens: TokenSource): Promise<string> {
    let open: OpenClient;
    try {
      open = await this.mcp.connect(resolved.account.id, tokens);
    } catch (error) {
      if (error instanceof AccountToolError) throw error;
      throw new ProviderError(`Couldn't reach Notion: ${messageOf(error)}`, null, false);
    }
    const { tools } = await open.client.listTools();
    const names = new Set(tools.map((entry) => entry.name));
    const missing = Object.values(NOTION_TOOL_NAMES).filter((name) => !names.has(name));
    if (missing.length)
      throw new ProviderError(
        `Notion no longer offers ${missing.join(", ")}. open-bot needs an update.`,
        null,
        false,
      );
    return `Connected to ${resolved.account.display}`;
  }

  problem(error: ProviderError): string {
    return error.message;
  }

  async call(tool: string, tc: ToolContext): Promise<ToolResult> {
    const notionTool = NOTION_TOOL_NAMES[tool];
    if (!notionTool) throw new AccountToolError(`Notion has no tool ${tool}.`);
    if (READS.has(tool)) return read(this.mcp, tool, notionTool, tc);
    return { type: "action", action: await prepare(this.host, tool, notionTool, tc) };
  }
}
