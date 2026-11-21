import { type HandoffItem } from "@open-bot/domain";

/**
 * Who a teammate handed the chat to. A server from before the database rename (migration 0035)
 * still names them `toBotName`: this build is installed before that deploy, and the migration
 * renames every stored handoff. A later build can read only `toTeammateName`.
 */
export function handoffName(item: HandoffItem): string {
  const older = item as Partial<HandoffItem> & { toBotName?: string }; // vocabulary: allow (an older server's key)
  return item.toTeammateName ?? older.toBotName ?? "a teammate"; // vocabulary: allow (see above)
}
