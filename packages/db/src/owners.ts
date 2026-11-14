// Who writes each table. Every table has one owner: the one module that inserts, updates and
// deletes its rows. Anything else that needs a change calls the owner (over the worker's internal
// API from the web app, or a function the owner exports that takes the caller's transaction).
// Any server code may read any table; phones and browsers never reach the database.
//
// The `open-bot/table-owners` lint rule (scripts/lint/table-owners.mjs) enforces this: a Drizzle
// `insert`, `update` or `delete` of a table, or raw SQL that writes one, fails lint outside the
// owner, except the columns a `shared` entry allows. Tests, the showcase seed and e2e stand-ins
// are exempt.
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
    owner: `${WORKER}features/teammates/service.ts`,
    shared: MEMORY_KEEPS(
      ["lessons_changed_at"],
      "lessons are rebuilt from memory in the memory write's transaction",
    ),
  },
  instruction_proposals: { owner: `${WORKER}features/teammates/service.ts` },
  skills: { owner: `${WORKER}features/skills/service.ts` },
  schedules: { owner: `${WORKER}features/automations/schedules.ts` },
  triggers: { owner: `${WORKER}features/automations/triggers.ts` },
  trigger_firings: { owner: `${WORKER}features/automations/account-triggers.ts` },
  approval_rules: { owner: `${WORKER}features/approvals/service.ts` },
  tasks: { owner: `${WORKER}features/tasks/service.ts` },

  // Chats and the work done in them.
  chats: { owner: `${WORKER}features/chat/service.ts` },
  chat_members: { owner: `${WORKER}features/chat/service.ts` },
  messages: { owner: `${WORKER}features/chat/service.ts` },
  uploads: { owner: `${WORKER}features/uploads/service.ts` },
  runs: {
    owner: `${WORKER}runs/`,
    shared: MEMORY_KEEPS(
      ["cancel_requested_at"],
      "a memory change stops the turns that read the old memory, atomically with the change",
    ),
  },
  run_events: { owner: `${WORKER}runs/` },
  bot_threads: { owner: `${WORKER}runs/` },
  message_dispatches: { owner: `${WORKER}runs/` },
  usage_entries: { owner: `${WORKER}runs/` },
  artifacts: { owner: `${WORKER}features/screens/tools.ts` },
  swarms: { owner: `${WORKER}features/teamwork/service.ts` },
  swarm_tasks: { owner: `${WORKER}features/teamwork/service.ts` },
  notifications: { owner: `${WORKER}features/notifications/service.ts` },

  // Pages.
  pages: { owner: `${WORKER}features/pages/service.ts` },
  page_versions: { owner: `${WORKER}features/pages/service.ts` },

  // Approvals, spending and the vault.
  approvals: { owner: `${WORKER}features/approvals/service.ts` },
  vault_items: { owner: `${WORKER}features/vault/service.ts` },
  purchases: { owner: `${WORKER}features/vault/service.ts` },

  // The computer, its screens and egress.
  computers: { owner: `${WORKER}egress/store.ts` },
  desktop_takeovers: { owner: `${WORKER}features/screens/takeovers.ts` },
  takeover_deliveries: { owner: `${WORKER}features/screens/takeovers.ts` },
  screen_operations: { owner: `${WORKER}features/screens/screen-operations.ts` },
  egress_devices: { owner: `${WORKER}egress/devices.ts` },

  // Settings, secrets and notifications to the owner's devices.
  settings: {
    owner: `${WORKER}features/settings/service.ts`,
    shared: MEMORY_KEEPS(
      ["id", "about_me", "about_me_updated_at"],
      "the profile is rebuilt from shared memory in the memory write's transaction (`id` because it makes the one row when there is none yet)",
    ),
  },
  credentials: { owner: `${WORKER}features/credentials/service.ts` },
  telegram: { owner: `${WORKER}features/telegram/` },
  telegram_messages: { owner: `${WORKER}features/telegram/` },
  push_subscriptions: { owner: `${WORKER}features/notifications/push.ts` },
  native_push_devices: { owner: `${WORKER}features/notifications/fcm.ts` },
  email_settings: { owner: `${WORKER}features/email/service.ts` },
  emails: { owner: `${WORKER}features/email/service.ts` },

  // Integrations: connections (MCP servers) and accounts (OAuth).
  connections: { owner: `${WORKER}features/connections/service.ts` },
  accounts: { owner: "packages/integrations/src/core/store.ts" },
  oauth_clients: { owner: "packages/integrations/src/core/clients.ts" },
  oauth_states: { owner: `${WEB}features/integrations/server/accounts.ts` },
  account_actions: { owner: `${WORKER}features/integrations/actions.ts` },
  account_resources: { owner: "packages/integrations/src/providers/notion/runner.ts" },

  // Memory.
  memory_items: { owner: MEMORY },
  memory_revisions: { owner: MEMORY },
  memory_generations: { owner: MEMORY },
  memory_jobs: { owner: MEMORY },
  memory_embeddings: { owner: MEMORY },
  memory_imports: { owner: MEMORY },
  memory_usage: { owner: MEMORY },
  memory_contexts: { owner: `${WORKER}features/memory/service.ts` },
  lessons: { owner: MEMORY },
} as const satisfies Record<Tables, TableOwner>;
