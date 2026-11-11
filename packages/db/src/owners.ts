// Who writes each table. Every table has one owner: the one module that inserts, updates and
// deletes its rows. Anything else that needs a change calls the owner (over the worker's internal
// API from the web app, or a function the owner exports that takes the caller's transaction).
// Any server code may read any table; phones and browsers never reach the database.
//
// The `open-bot/table-owners` lint rule (scripts/lint/table-owners.mjs) enforces this: a Drizzle
// `insert`, `update` or `delete` of a table, or raw SQL that writes one, fails lint outside the
// owner and the paths listed with it. Tests, the showcase seed and e2e stand-ins are exempt.
// This file is read by ESLint through Node's type stripping: keep it free of runtime imports.

import type * as schema from "./schema";

type Tables = {
  [K in keyof typeof schema]: (typeof schema)[K] extends { _: { name: infer N extends string } }
    ? N
    : never;
}[keyof typeof schema];

/** A path from the repo root: a file, or a folder ending in "/". */
type RepoPath = string;

export interface TableOwner {
  /** The module that writes the table. */
  owner: RepoPath;
  /**
   * Another module that writes some columns in the same transaction as its own change, and why
   * calling the owner instead doesn't work yet. It may only set these columns, never delete.
   */
  shared?: readonly { by: RepoPath; columns: readonly string[]; why: string }[];
  /** Writers still to be moved behind the owner. This list only shrinks. */
  moving?: readonly RepoPath[];
}

const WEB = "apps/web/src/";
const WORKER = "apps/worker/src/";
const MEMORY = "packages/memory/src/";

/** Better Auth writes its own tables, through the Drizzle adapter configured here. */
const BETTER_AUTH: TableOwner = { owner: `${WEB}lib/server/auth.ts` };

/** The memory package keeps its compatibility tables current in the same transaction. */
const MEMORY_KEEPS = (columns: readonly string[], why: string) => [{ by: MEMORY, columns, why }];

export const TABLE_OWNERS = {
  // Sign-in (Better Auth). Unrelated to the integrations `accounts` table.
  user: BETTER_AUTH,
  session: BETTER_AUTH,
  account: BETTER_AUTH,
  verification: BETTER_AUTH,
  passkey: BETTER_AUTH,

  // Teammates and what they're set up with.
  bots: {
    // vocabulary: allow
    owner: `${WORKER}services/bots.ts`, // vocabulary: allow
    shared: MEMORY_KEEPS(
      ["lessons_changed_at"],
      "lessons are rebuilt from memory in the memory write's transaction",
    ),
    moving: [`${WEB}lib/server/api/teammates.ts`],
  },
  instruction_proposals: {
    owner: `${WORKER}services/bots.ts`, // vocabulary: allow
    moving: [`${WEB}lib/server/api/teammates.ts`, `${WORKER}tools/handlers.ts`],
  },
  skills: { owner: `${WORKER}services/skills.ts`, moving: [`${WEB}lib/server/teammates.ts`] },
  schedules: {
    owner: `${WORKER}services/schedules.ts`,
    moving: [
      `${WEB}lib/server/api/automations.ts`,
      `${WEB}lib/server/api/teammates.ts`,
      `${WEB}lib/server/teammates.ts`,
    ],
  },
  triggers: {
    owner: `${WORKER}services/triggers.ts`,
    moving: [
      `${WEB}lib/server/api/teammates.ts`,
      `${WEB}lib/server/teammates.ts`,
      `${WORKER}services/account-triggers.ts`,
    ],
  },
  trigger_firings: { owner: `${WORKER}services/account-triggers.ts` },
  approval_rules: {
    owner: `${WORKER}services/approvals.ts`,
    moving: [`${WEB}lib/server/teammates.ts`],
  },
  tasks: { owner: `${WORKER}services/tasks.ts` },

  // Chats and the work done in them.
  chats: {
    owner: `${WORKER}services/chats.ts`,
    moving: [
      `${WEB}lib/server/api/chats.ts`,
      `${WEB}lib/server/api/teammates.ts`,
      `${WORKER}runs/executor.ts`,
      `${WORKER}runs/session.ts`,
      `${WORKER}services/bots.ts`, // vocabulary: allow
      `${WORKER}services/email.ts`,
      `${WORKER}services/schedules.ts`,
      `${WORKER}services/swarms.ts`,
      `${WORKER}tools/handlers.ts`,
    ],
  },
  chat_members: { owner: `${WORKER}services/chats.ts`, moving: [`${WEB}lib/server/api/chats.ts`] },
  messages: {
    owner: `${WORKER}services/chats.ts`,
    moving: [
      `${WEB}lib/server/api/chats.ts`,
      `${WEB}lib/server/api/runs.ts`,
      `${WORKER}runs/executor.ts`,
      `${WORKER}services/telegram.ts`,
    ],
  },
  uploads: { owner: `${WORKER}uploads.ts` },
  runs: {
    owner: `${WORKER}runs/`,
    shared: MEMORY_KEEPS(
      ["cancel_requested_at"],
      "a memory change stops the turns that read the old memory, atomically with the change",
    ),
    moving: [
      `${WEB}lib/server/api/runs.ts`,
      `${WEB}lib/server/api/teammates.ts`,
      `${WORKER}context.ts`,
      `${WORKER}services/swarms.ts`,
    ],
  },
  run_events: { owner: `${WORKER}runs/`, moving: [`${WORKER}context.ts`] },
  bot_threads: { owner: `${WORKER}runs/` }, // vocabulary: allow
  message_dispatches: { owner: `${WORKER}runs/` },
  usage_entries: { owner: `${WORKER}runs/` },
  artifacts: { owner: `${WORKER}tools/handlers.ts` },
  swarms: { owner: `${WORKER}services/swarms.ts` },
  swarm_tasks: { owner: `${WORKER}services/swarms.ts` },
  notifications: {
    owner: `${WORKER}services/notifications.ts`,
    moving: [`${WEB}lib/server/api/notifications.ts`, `${WORKER}context.ts`],
  },

  // Pages.
  pages: { owner: `${WORKER}services/pages.ts`, moving: [`${WEB}lib/server/api/pages.ts`] },
  page_versions: { owner: `${WORKER}services/pages.ts` },

  // Approvals, spending and the vault.
  approvals: {
    owner: `${WORKER}services/approvals.ts`,
    moving: [`${WEB}lib/server/accounts.ts`, `${WORKER}accounts/actions.ts`],
  },
  vault_items: { owner: `${WORKER}services/vault.ts`, moving: [`${WEB}lib/server/api/vault.ts`] },
  purchases: { owner: `${WORKER}services/vault.ts`, moving: [`${WORKER}services/approvals.ts`] },

  // The computer, its screens and egress.
  computers: { owner: `${WORKER}egress/store.ts`, moving: [`${WORKER}index.ts`] },
  desktop_takeovers: { owner: `${WORKER}services/takeovers.ts` }, // vocabulary: allow
  takeover_deliveries: { owner: `${WORKER}services/takeovers.ts` },
  screen_operations: {
    owner: `${WORKER}services/screen-operations.ts`,
    moving: [`${WORKER}services/takeovers.ts`],
  },
  egress_devices: {
    owner: `${WORKER}egress/devices.ts`,
    moving: [
      `${WEB}app/api/egress/device/push-token/route.ts`,
      `${WEB}app/api/egress/device/token/route.ts`,
      `${WEB}lib/server/api/egress.ts`,
      `${WORKER}services/fcm.ts`,
    ],
  },

  // Settings, secrets and notifications to the owner's devices.
  settings: {
    owner: `${WORKER}services/settings.ts`,
    shared: MEMORY_KEEPS(
      ["id", "about_me", "about_me_updated_at"],
      "the profile is rebuilt from shared memory in the memory write's transaction (`id` because it makes the one row when there is none yet)",
    ),
    moving: [
      `${WEB}lib/server/api/settings.ts`,
      `${WORKER}index.ts`,
      `${WORKER}services/codex-account.ts`,
      `${WORKER}services/model-access.ts`,
    ],
  },
  credentials: {
    owner: `${WORKER}services/credentials.ts`,
    moving: [
      `${WEB}lib/server/api/integrations.ts`,
      `${WEB}lib/server/api/settings.ts`,
      `${WORKER}services/push.ts`,
      `${WORKER}services/telegram.ts`,
    ],
  },
  telegram: { owner: `${WORKER}services/telegram.ts` },
  telegram_messages: { owner: `${WORKER}services/telegram.ts` },
  push_subscriptions: { owner: `${WORKER}services/push.ts` },
  native_push_devices: { owner: `${WORKER}services/fcm.ts` },
  email_settings: {
    owner: `${WORKER}services/email.ts`,
    moving: [`${WEB}lib/server/api/integrations.ts`, `${WEB}lib/server/queries.ts`],
  },
  emails: { owner: `${WORKER}services/email.ts` },

  // Integrations: connections (MCP servers) and accounts (OAuth).
  connections: {
    owner: `${WORKER}services/connections.ts`,
    moving: [
      `${WEB}lib/server/accounts.ts`,
      `${WEB}lib/server/api/integrations.ts`,
      `${WORKER}services/bots.ts`, // vocabulary: allow
    ],
  },
  accounts: { owner: "packages/accounts/src/store.ts", moving: [`${WORKER}accounts/access.ts`] },
  oauth_clients: { owner: "packages/accounts/src/clients.ts" },
  oauth_states: { owner: `${WEB}lib/server/accounts.ts` },
  account_actions: {
    owner: `${WORKER}accounts/actions.ts`,
    moving: [`${WEB}lib/server/accounts.ts`, `${WORKER}services/approvals.ts`],
  },
  account_resources: { owner: `${WORKER}accounts/notion.ts` },

  // Memory.
  memory_items: { owner: MEMORY },
  memory_revisions: { owner: MEMORY },
  memory_generations: { owner: MEMORY },
  memory_jobs: { owner: MEMORY },
  memory_embeddings: { owner: MEMORY },
  memory_imports: { owner: MEMORY },
  memory_usage: { owner: MEMORY },
  memory_contexts: {
    owner: `${WORKER}services/memory.ts`,
    moving: [`${WORKER}tools/handlers.ts`],
  },
  lessons: { owner: MEMORY, moving: [`${WEB}lib/server/teammates.ts`] },
} as const satisfies Record<Tables, TableOwner>;
