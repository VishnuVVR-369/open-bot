// The catalog: every agent tool, from the feature that owns it. Adding a tool is one defineTool()
// in its feature's file; this list, the specs Codex is given and dispatch all follow from it.
import type { v2 } from "@open-bot/agent";
import { ACCOUNT_TOOL_SPECS } from "@open-bot/integrations/adapters";
import { AUTOMATION_TOOLS } from "../features/automations";
import { CHAT_TOOLS } from "../features/chat";
import { APPROVAL_TOOLS } from "../features/approvals";
import { TAKEOVER_TOOLS } from "../features/screens";
import { TASK_TOOLS } from "../features/tasks";
import { toolSpec, type AnyTool } from "./define";
import { DESKTOP_TOOLS } from "../features/screens";
import { EMAIL_TOOLS } from "../features/email";
import { MEMORY_TOOLS } from "../features/memory";
import { PAGE_TOOLS } from "../features/pages";
import { SKILL_TOOLS } from "../features/skills";
import { SWARM_TOOLS } from "../features/teamwork";
import { TEAMMATE_TOOLS } from "../features/teammates";
import { TEAMWORK_TOOLS } from "../features/teamwork";
import { VAULT_TOOLS } from "../features/vault";

export const TOOLS: readonly AnyTool[] = [
  ...DESKTOP_TOOLS,
  ...TEAMMATE_TOOLS,
  ...CHAT_TOOLS,
  ...APPROVAL_TOOLS,
  ...TAKEOVER_TOOLS,
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

const BY_NAME = new Map<string, AnyTool>();
for (const tool of TOOLS) {
  if (BY_NAME.has(tool.name)) throw new Error(`Two tools are named ${tool.name}.`);
  BY_NAME.set(tool.name, tool);
}

/** The tool Codex called, by name. */
export function toolNamed(name: string): AnyTool | undefined {
  return BY_NAME.get(name);
}

// Every thread gets every tool, so a teammate's threads behave the same in any chat.
const SPECS: readonly v2.DynamicToolSpec[] = [...TOOLS.map(toolSpec), ...ACCOUNT_TOOL_SPECS];

export function toolsFor(): v2.DynamicToolSpec[] {
  return [...SPECS];
}
