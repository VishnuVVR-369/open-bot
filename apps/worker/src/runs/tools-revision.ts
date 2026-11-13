import { createHash } from "node:crypto";
import type { v2 } from "@open-bot/agent";

/**
 * A hash of what a Codex thread is started with: the developer instructions and every tool spec.
 * Threads keep both for life, so a thread from another revision is replaced by a fresh one.
 */
export function toolsRevision(
  developerInstructions: string,
  dynamicTools: readonly v2.DynamicToolSpec[],
): string {
  return createHash("sha256")
    .update(JSON.stringify({ developerInstructions, dynamicTools }))
    .digest("base64url");
}
