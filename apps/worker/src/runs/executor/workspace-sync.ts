// Writes a teammate's workspace on the computer: AGENTS.md from its profile, approval rules,
// teammates, connections and accounts, then its memory pointer and skills.
import { teammates as teammateRows } from "@open-bot/db";
import { COMPUTER_PATHS, emailAddress } from "@open-bot/domain";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import type { Context } from "../../context";
import type { Bot } from "../../core/db-types";
import type { ApprovalService } from "../../features/approvals";
import type { ConnectionService } from "../../features/connections";
import { emailSettingsRow } from "../../features/email";
import type { AccountAccess } from "../../features/integrations";
import type { MemoryCoordinator } from "../../features/memory";
import type { SkillService } from "../../features/skills";
import { agentsMarkdown } from "../../instructions";

/** What writing a workspace reads from the executor. */
export interface WorkspaceExecutor {
  readonly ctx: Context;
  readonly skills: SkillService;
  readonly approvals: ApprovalService;
  readonly connections: ConnectionService;
  readonly accounts: AccountAccess;
  readonly memory: MemoryCoordinator;
}

/** Write the teammate's AGENTS.md, MEMORY.md and skills. */
export async function syncWorkspace(
  executor: WorkspaceExecutor,
  bot: Pick<Bot, "id" | "slug" | "name" | "role" | "instructions" | "autonomy">,
): Promise<string> {
  // Configuration may have changed while the computer woke. Always project the latest revision.
  const [latest] = await executor.ctx.db
    .select()
    .from(teammateRows)
    .where(eq(teammateRows.id, bot.id));
  if (!latest || latest.archivedAt) throw new Error("Teammate is no longer available");
  Object.assign(bot, latest);
  const client = await executor.ctx.codex.ready();
  await executor.skills.syncAll();
  const workspace = COMPUTER_PATHS.workspace(bot.slug);
  const rules = await executor.approvals.rulesFor(bot.id);

  const teammates = await executor.ctx.db
    .select({ name: teammateRows.name, role: teammateRows.role })
    .from(teammateRows)
    .where(and(isNull(teammateRows.archivedAt), ne(teammateRows.id, bot.id)))
    .orderBy(asc(teammateRows.createdAt));
  const { labels: services } = await executor.connections.forBot(bot.id);
  const { domain } = await emailSettingsRow(executor.ctx);
  const address = domain ? emailAddress(bot.slug, domain) : null;
  await client.request("fs/createDirectory", { path: workspace, recursive: true });
  const accounts = await executor.accounts.lines(bot.id);
  const instructions = agentsMarkdown(bot, rules, "", [], teammates, services, address, accounts);
  await client.request("fs/writeFile", {
    path: `${workspace}/AGENTS.md`,
    dataBase64: Buffer.from(instructions).toString("base64"),
  });
  await executor.memory.prepare(bot);
  await executor.skills.syncBot(bot);
  return instructions;
}
