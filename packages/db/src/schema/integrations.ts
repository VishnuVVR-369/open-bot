// Integrations: OAuth accounts, MCP connections, and the actions and resources they carry.
import {
  type AccountActionPreview,
  type AccountActionStatus,
  type AccountCapability,
  type AccountProvider,
  type AccountStatus,
  type ActionEffect,
  type ConnectionKind,
  type ConnectionSettings,
  type ConnectionTransport,
  type OAuthClientSource,
} from "@open-bot/domain";
import {
  check,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { chats } from "./chats";
import { createdAt, updatedAt } from "./columns";
import { runs } from "./runs";
import { teammates } from "./teammates";

/**
 * The OAuth clients accounts sign in through: one you made in a provider's console and pasted into
 * Settings (Google's), or one this app registered itself (Notion's, by dynamic registration). A
 * provider has one current client, which new sign-ins use; a replaced one is retired, and stays
 * while a grant still belongs to it, since only it can refresh that grant.
 */
export const oauthClients = pgTable(
  "oauth_clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").$type<AccountProvider>().notNull(),
    source: text("source").$type<OAuthClientSource>().notNull(),
    clientId: text("client_id").notNull(),
    /** AES-256-GCM of the client secret; null for a public client. */
    encryptedSecret: text("encrypted_secret"),
    /** What Settings shows of it, without the secret. */
    hint: text("hint"),
    /** Registered clients: the authorization server, and the redirect URI it was registered with. */
    issuer: text("issuer"),
    redirectUri: text("redirect_uri"),
    /** Replaced by a newer client: no new sign-ins, but its grants still refresh. */
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("oauth_clients_identity_unique").on(table.provider, table.clientId),
    uniqueIndex("oauth_clients_current_unique")
      .on(table.provider)
      .where(sql`${table.retiredAt} is null`),
  ],
);

/** The decrypted token set of an account. */
export interface AccountTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds. */
  expiresAt: number | null;
  tokenType: string;
}

/**
 * Your accounts at auth providers (Google, Notion) that teammates use: who you are there, what you
 * granted, and the tokens, encrypted. Only the worker decrypts them; they never reach the computer.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").$type<AccountProvider>().notNull(),
    /** Who you are at the provider, stably: Google's `sub`, or Notion's `workspace_id:user_id`. */
    externalId: text("external_id").notNull(),
    /**
     * The OAuth client the grant was made to, which refreshes it. Replacing the client in Settings
     * leaves this one in place until you reconnect, so the grant keeps working meanwhile.
     */
    oauthClientId: uuid("oauth_client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "restrict" }),
    /** What Settings shows: an email address, or a workspace's name. */
    display: text("display").notNull(),
    /** Granted scopes, as the provider reported them. */
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** AES-256-GCM of the token set as JSON (see `AccountTokens`). */
    encrypted: text("encrypted").notNull(),
    /** Bumped by every change to the tokens, so writers can tell they raced. */
    credentialVersion: integer("credential_version").notNull().default(1),
    /**
     * Bumped when the grant loses something an approval may rely on: a scope it had, or the
     * client it was made to. A pending action made under another revision never runs.
     */
    grantRevision: integer("grant_revision").notNull().default(1),
    status: text("status").$type<AccountStatus>().notNull().default("connected"),
    lastError: text("last_error"),
    /** When you last granted it from scratch: some providers end grants a while after this. */
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /** Set once you've been told it needs reconnecting, so it's said once. */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("accounts_identity_unique").on(table.provider, table.externalId)],
);

/**
 * Services teammates use through MCP, like GitHub, Notion or a company API: faster and more
 * reliable than driving their websites. Headers and environment variables are encrypted.
 */
export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** What you call it, like "GitHub". */
    label: text("label").notNull(),
    /** Its name for Codex: letters, digits, _ and -. Unique. */
    name: text("name").notNull(),
    /** An MCP server you added, or one of your accounts (Gmail, Google Calendar, Notion). */
    kind: text("kind").$type<ConnectionKind>().notNull().default("mcp"),
    /** For MCP servers: how Codex reaches it. Null for accounts, which the worker serves. */
    transport: text("transport").$type<ConnectionTransport>(),
    /** For http: the MCP endpoint. */
    url: text("url"),
    /** For stdio: the command the computer runs, and its arguments. */
    command: text("command"),
    args: text("args")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** AES-256-GCM ciphertext of { headers, env } as JSON. */
    encrypted: text("encrypted"),
    /** The header and variable names, without their values, to show what's set. */
    secretNames: text("secret_names")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** The teammates that may use it, or null for every teammate. */
    teammateIds: uuid("bot_ids").array(),
    enabled: boolean("enabled").notNull().default(true),
    /** For accounts: the signed-in account it uses. Removed only by revoking the account. */
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "restrict" }),
    /** For accounts: what teammates may do with it. */
    capabilities: text("capabilities")
      .array()
      .$type<AccountCapability[]>()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** For accounts: anything others see asks you, even for teammates that work on their own. */
    askBeforeActing: boolean("ask_before_acting").notNull().default(true),
    /**
     * Bumped by every change to who may use it and how, so an action approved under one setup
     * doesn't run under another.
     */
    revision: integer("revision").notNull().default(1),
    /** For accounts: the integration's settings, like Notion's teammates' area. */
    settings: jsonb("settings").$type<ConnectionSettings>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("connections_name_unique").on(table.name),
    // One connection of each kind per account (one Gmail and one Calendar per Google account).
    uniqueIndex("connections_account_kind_unique")
      .on(table.accountId, table.kind)
      .where(sql`${table.accountId} is not null`),
    check(
      "connections_kind_shape",
      sql`(${table.kind} = 'mcp' and ${table.transport} is not null and ${table.accountId} is null) or (${table.kind} <> 'mcp' and ${table.transport} is null and ${table.accountId} is not null)`,
    ),
  ],
);

export interface OAuthPurpose {
  kind: Exclude<ConnectionKind, "mcp">;
  capabilities: AccountCapability[];
  botIds: string[] | null;
  /** The OAuth client the sign-in started with; the code is exchanged with the same one. */
  oauthClientId: string;
  /** Reconnecting or widening this account: the callback must sign in as the same identity. */
  accountId?: string;
  expectedExternalId?: string;
}

/** Sign-ins in progress: each lives 10 minutes and is used once. */
export const oauthStates = pgTable(
  "oauth_states",
  {
    state: text("state").primaryKey(),
    provider: text("provider").$type<AccountProvider>().notNull(),
    /** The PKCE verifier, encrypted. */
    verifier: text("verifier").notNull(),
    /** The signed-in session that started it; the callback must come back to the same one. */
    sessionId: text("session_id").notNull(),
    purpose: jsonb("purpose").$type<OAuthPurpose>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("oauth_states_expires_idx").on(table.expiresAt)],
);

/**
 * Every change teammates make to your accounts, frozen as the exact request, and what happened
 * to it. What you approve is what runs, at most once, even after the run that asked ended.
 */
export const accountActions = pgTable(
  "account_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id").references(() => connections.id, {
      onDelete: "set null",
    }),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
    /** The account's grant and the connection's setup when it was made; both must still hold. */
    grantRevision: integer("grant_revision").notNull(),
    connectionRevision: integer("connection_revision").notNull(),
    teammateId: uuid("bot_id").references(() => teammates.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    chatId: uuid("chat_id").references(() => chats.id, { onDelete: "set null" }),
    /** The tool call's timeline item, updated as the action moves on. */
    itemId: text("item_id").notNull(),
    /** Like `gmail.send_draft`. */
    tool: text("tool").notNull(),
    effect: text("effect").$type<ActionEffect>().notNull(),
    /** The exact provider request, frozen when the action was made. */
    request: jsonb("request").$type<Record<string, unknown>>().notNull(),
    /** One line on what it does, for the timeline and notifications. */
    summary: text("summary").notNull(),
    /** How its timeline item reads while it waits for you, once it's done, and if it fails. */
    labels: jsonb("labels").$type<{ waiting: string; done: string; failed: string }>().notNull(),
    preview: jsonb("preview").$type<AccountActionPreview>(),
    status: text("status").$type<AccountActionStatus>().notNull().default("pending"),
    approvalId: uuid("approval_id"),
    /** How many times the executor claimed it. */
    attempt: integer("attempt").notNull().default(0),
    /** Provider ids: the event and its etag, the sent message, Notion's task or page. */
    providerRef: jsonb("provider_ref").$type<Record<string, unknown>>(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    /** Waiting on Notion's async task: when to look again. */
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
    createdAt: createdAt(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /**
     * When its outcome reached the teammate and the timeline. Finished actions without it are
     * still to be reported, so an outcome is told once, even across a restart.
     */
    reportedAt: timestamp("reported_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("account_actions_status_idx").on(table.status, table.nextCheckAt),
    index("account_actions_unreported_idx")
      .on(table.finishedAt)
      .where(sql`${table.reportedAt} is null and ${table.finishedAt} is not null`),
    uniqueIndex("account_actions_approval_unique").on(table.approvalId),
    index("account_actions_connection_idx").on(table.connectionId, table.status),
  ],
);

/**
 * Things teammates made in your accounts, like Notion pages, which they may keep changing under
 * their autonomy instead of asking each time.
 */
export const accountResources = pgTable(
  "account_resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    /** The provider's id, normalized (Notion page ids without dashes). */
    externalId: text("external_id").notNull(),
    /** What it is, in the integration's words, like `notion_page`. */
    kind: text("kind").notNull(),
    /** Created without a parent: only you can see it. */
    private: boolean("private").notNull().default(false),
    actionId: uuid("action_id").references(() => accountActions.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("account_resources_unique").on(table.connectionId, table.externalId)],
);
