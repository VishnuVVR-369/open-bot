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
 * Names in TOOL_DISPLAY that no teammate can call today: a step the worker adds itself, and
 * retired tools whose steps are still in older chats.
 */
export const NOT_CURRENT_TOOLS: readonly string[] = [
  "model_fallback",
  "cancel_schedule",
  "list_schedules",
];

/** Tools shown with more than the default, by name. */
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
  cancel_schedule: { icon: "schedule" },
  list_schedules: { icon: "schedule" },
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
  // Own keys only, so a name like `constructor` gets the default, not Object's.
  if (Object.hasOwn(TOOL_DISPLAY, name)) return TOOL_DISPLAY[name]!;
  const namespace = name.split(".")[0]!;
  if (Object.hasOwn(NAMESPACE_ICONS, namespace)) return { icon: NAMESPACE_ICONS[namespace]! };
  return DEFAULT_DISPLAY;
}
