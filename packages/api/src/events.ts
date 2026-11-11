import type { AppEventType } from "@open-bot/domain";
import type { Contract } from "./contract";

/** A namespace of the contract (`["schedules"]`) or one procedure in it (`["schedules", "list"]`). */
export type ProcedurePath = {
  [K in keyof Contract]: [K] | { [P in keyof Contract[K]]: [K, P] }[keyof Contract[K]];
}[keyof Contract];

/**
 * What each app event makes stale, as procedure paths: a client refreshes every query it has under
 * them. Every event also refreshes `app.state` and `home.get`, the snapshots with the shell's
 * badges, so they aren't repeated here. Anything else is refreshed when the stream reconnects.
 *
 * It's a record over every event type, so adding an event without saying what it refreshes, or
 * naming a procedure that doesn't exist, fails to compile.
 */
export const APP_EVENT_REFRESHES: Record<AppEventType, readonly ProcedurePath[]> = {
  memory: [["memory"]],
  lease: [["screens", "list"]],
  computer: [["screens", "list"]],
  notification: [["notifications"]],
  approvals: [["approvals"]],
  takeovers: [["screens", "list"]],
  bots: [
    ["teammates", "list"],
    ["chats", "list"],
  ],
  // Runs starting and finishing show up in automations' history and in chat lists. An open chat
  // follows its own stream, so `chats.get` isn't refreshed for every chat's news.
  chats: [["chats", "list"], ["schedules"], ["triggers"], ["teammates", "list"]],
  schedules: [["schedules"]],
  triggers: [["triggers"]],
  profile: [["profile"]],
  lessons: [["teammates", "lessons"]],
  tasks: [["tasks"]],
  telegram: [["telegram"]],
  skills: [["skills"]],
  vault: [["vault"]],
  // Accounts are connections too: signing in or out changes both lists.
  connections: [["connections"], ["accounts"]],
  email: [["email"]],
  purchases: [["teammates", "spending"]],
  // Not `pages.open`: its links are short-lived on purpose, and a new one reloads the open page.
  pages: [
    ["pages", "list"],
    ["pages", "get"],
    ["pages", "search"],
  ],
  // The ChatGPT sign-in, and the API key that takes over when the plan runs out.
  auth: [["settings", "modelAccess"]],
  // The owner's settings, like the time zone, which only the shell's state carries.
  settings: [],
};

/** The snapshots every event refreshes, on top of what `APP_EVENT_REFRESHES` lists. */
export const ALWAYS_REFRESHED: readonly ProcedurePath[] = [
  ["app", "state"],
  ["home", "get"],
];
