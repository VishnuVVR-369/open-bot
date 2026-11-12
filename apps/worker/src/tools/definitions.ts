// The catalog: every agent tool, from the feature that owns it. Adding a tool is one defineTool()
// in its feature's file; this list, the specs Codex is given and dispatch all follow from it.
import type { v2 } from "@open-bot/agent";
import { ACCOUNT_TOOL_SPECS } from "@open-bot/integrations/adapters";
import { AUTOMATION_TOOLS } from "./automations";
import { CHAT_TOOLS } from "./chat";
import { toolSpec, type ToolDefinition } from "./define";
import { DESKTOP_TOOLS } from "./desktop";
import { EMAIL_TOOLS } from "./email";
import { MEMORY_TOOLS } from "./memory";
import { PAGE_TOOLS } from "./pages";
import { SKILL_TOOLS } from "./skills";
import { SWARM_TOOLS } from "./swarms";
import { TASK_TOOLS } from "./tasks";
import { TEAMMATE_TOOLS } from "./teammates";
import { TEAMWORK_TOOLS } from "./teamwork";
import { VAULT_TOOLS } from "./vault";

/**
 * Bump when the tool set or the developer instructions change.
 * Codex threads keep the tools they started with, so a new version starts fresh threads.
 */
export const TOOLS_VERSION = 20;

export const TOOLS: readonly ToolDefinition[] = [
  ...DESKTOP_TOOLS,
  ...TEAMMATE_TOOLS,
  ...CHAT_TOOLS,
  ...AUTOMATION_TOOLS,
  ...SKILL_TOOLS,
  ...TASK_TOOLS,
  ...MEMORY_TOOLS,
  ...VAULT_TOOLS,
  ...EMAIL_TOOLS,
  ...SWARM_TOOLS,
  ...PAGE_TOOLS,
  ...TEAMWORK_TOOLS,
];

const BY_NAME = new Map<string, ToolDefinition>();
for (const tool of TOOLS) {
  if (BY_NAME.has(tool.name)) throw new Error(`Two tools are named ${tool.name}.`);
  BY_NAME.set(tool.name, tool);
}

/** The tool Codex called, by name. */
export function toolNamed(name: string): ToolDefinition | undefined {
  return BY_NAME.get(name);
}

// Every thread gets every tool, so a bot's threads behave the same in any chat.
const SPECS: readonly v2.DynamicToolSpec[] = [...TOOLS.map(toolSpec), ...ACCOUNT_TOOL_SPECS];

export function toolsFor(): v2.DynamicToolSpec[] {
  return [...SPECS];
}
