/**
 * How the apps show a tool step. Icons are named by meaning, and web and mobile each map every
 * meaning to an icon of their own, so a new meaning fails to compile until both draw it.
 */
export const TOOL_ICON_LIST = [
  "tool",
  "notification",
  "email",
  "schedule",
  "calendar",
  "question",
  "tasks",
  "suggestion",
  "skill",
  "watch",
  "webhook",
  "history",
  "profile",
  "key",
  "payment",
  "notes",
] as const;
export type ToolIcon = (typeof TOOL_ICON_LIST)[number];

export interface ToolDisplay {
  icon: ToolIcon;
  /**
   * The call is itself a request for the user's approval, so the approval card right after it
   * says it all and the step isn't shown above it.
   */
  asksApproval?: true;
}

/**
 * Tools shown with more than the default, by name. `model_fallback` is a step the worker adds
 * itself, not a tool. The worker's tool list test checks every other name is a tool.
 */
export const TOOL_DISPLAY: Readonly<Record<string, ToolDisplay>> = {
  notify_user: { icon: "notification" },
  request_approval: { icon: "tool", asksApproval: true },
  send_email: { icon: "email", asksApproval: true },
  list_emails: { icon: "email" },
  schedule_task: { icon: "schedule" },
  list_automations: { icon: "schedule" },
  cancel_automation: { icon: "schedule" },
  update_automation: { icon: "schedule" },
  watch_page: { icon: "watch" },
  watch_gmail: { icon: "email" },
  watch_calendar: { icon: "calendar" },
  create_webhook: { icon: "webhook" },
  ask_teammate: { icon: "question" },
  list_tasks: { icon: "tasks" },
  add_task: { icon: "tasks" },
  update_task: { icon: "tasks" },
  propose_instructions: { icon: "suggestion" },
  save_skill: { icon: "skill" },
  search_history: { icon: "history" },
  remember_about_user: { icon: "profile" },
  vault_fill: { icon: "key" },
  start_purchase: { icon: "payment", asksApproval: true },
  finish_purchase: { icon: "payment" },
  model_fallback: { icon: "key" },
};

/** Account tools are named by namespace: `gmail.search`, `calendar.create_event`. */
const NAMESPACE_ICONS: Readonly<Record<string, ToolIcon>> = {
  gmail: "email",
  calendar: "calendar",
  notion: "notes",
};

const DEFAULT_DISPLAY: ToolDisplay = { icon: "tool" };

/** How to show a step of the tool `name`. */
export function toolDisplay(name: string): ToolDisplay {
  const namespaced = NAMESPACE_ICONS[name.split(".")[0]!];
  return TOOL_DISPLAY[name] ?? (namespaced ? { icon: namespaced } : DEFAULT_DISPLAY);
}
