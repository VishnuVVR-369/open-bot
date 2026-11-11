import {
  ACCOUNT_CONNECTION_KINDS,
  ACCOUNT_PROVIDERS,
  ACCOUNT_STATUSES,
  type AccountCapability,
  type AccountConnectionKind,
  type AccountProvider,
} from "@open-bot/domain";
import { z } from "zod";
import { id, teammateAccessSchema } from "./base";

/** Integrations as Settings shows them: connections (MCP servers and accounts) and email. */

const isoDate = z.string();

export const accountProviderSchema = z.enum(
  ACCOUNT_PROVIDERS as [AccountProvider, ...AccountProvider[]],
);

const accountKinds = ACCOUNT_CONNECTION_KINDS as [
  AccountConnectionKind,
  ...AccountConnectionKind[],
];

/** The kinds of account connection, like Gmail and Google Calendar. */
export const accountConnectionKindSchema = z.enum(accountKinds);

export const connectionKindSchema = z.enum(["mcp", ...accountKinds]);

/**
 * A capability as stored on a connection. Not an enum: a row saved before an integration dropped
 * a capability must still list, so Settings can show it and you can turn it off.
 */
const capabilitySchema = z.custom<AccountCapability>((value) => typeof value === "string");

/** A signed-in account at an auth provider (a Google account, a Notion workspace). */
export const accountViewSchema = z.object({
  id: z.string(),
  provider: accountProviderSchema,
  /** An email address, or the workspace's name. */
  display: z.string(),
  status: z.enum(ACCOUNT_STATUSES),
  lastError: z.string().nullable(),
  lastUsedAt: isoDate.nullable(),
  /** When the provider ends its grant and it must be connected again, for providers that do. */
  expiresAt: isoDate.nullable(),
});
export type AccountView = z.infer<typeof accountViewSchema>;

/** One of an integration's settings on a connection: what it points at. */
export const connectionSettingViewSchema = z.object({
  key: z.string(),
  /** The provider's id for it, like a Notion page's. */
  id: z.string(),
  title: z.string(),
  url: z.string().nullable(),
});
export type ConnectionSettingView = z.infer<typeof connectionSettingViewSchema>;

/** A service teammates use through MCP, without its secrets. */
export const connectionViewSchema = z.object({
  id: z.string(),
  label: z.string(),
  name: z.string(),
  /** An MCP server you added, or one of your accounts. */
  kind: connectionKindSchema,
  /** MCP servers only. */
  transport: z.enum(["http", "stdio"]).nullable(),
  url: z.string().nullable(),
  command: z.string().nullable(),
  args: z.array(z.string()),
  /** The header or variable names that are set, without their values. */
  secretNames: z.array(z.string()),
  botIds: z.array(z.string()).nullable(),
  enabled: z.boolean(),
  updatedAt: isoDate,
  /** Accounts only: the signed-in account, what teammates may do, and what you allowed. */
  account: accountViewSchema.nullable(),
  capabilities: z.array(capabilitySchema),
  /** Capabilities you picked that the provider's consent screen left out. */
  missingCapabilities: z.array(capabilitySchema),
  askBeforeActing: z.boolean(),
  /** Accounts only: the integration's settings that are set, like Notion's teammates' area. */
  settings: z.array(connectionSettingViewSchema),
});
export type ConnectionView = z.infer<typeof connectionViewSchema>;

/** What signing in at a provider needs. */
export const providerSetupViewSchema = z.object({
  id: accountProviderSchema,
  label: z.string(),
  /** `owner`: you paste a client from the provider's console; `automatic`: open-bot registers. */
  client: z.enum(["owner", "automatic"]),
  /** Ready for sign-ins: always, for automatic clients. */
  configured: z.boolean(),
  /** What Settings shows of your client, without its secret. */
  hint: z.string().nullable(),
  /** The address to register with the provider. */
  redirectUri: z.string(),
});
export type ProviderSetupView = z.infer<typeof providerSetupViewSchema>;

/** What connecting accounts needs, per provider, and the accounts already signed in, to reuse. */
export const accountsSetupViewSchema = z.object({
  providers: z.array(providerSetupViewSchema),
  accounts: z.array(accountViewSchema),
});
export type AccountsSetupView = z.infer<typeof accountsSetupViewSchema>;

/** Email for teammates: the domain, Postmark, and each teammate's address. */
export const emailStatusViewSchema = z.object({
  domain: z.string().nullable(),
  /** Where Postmark should deliver inbound email, as a path on this app. */
  inboundPath: z.string(),
  /** A safe hint of the Postmark server token, when one is saved. */
  tokenHint: z.string().nullable(),
  lastReceivedAt: isoDate.nullable(),
  addresses: z.array(z.object({ botId: z.string(), name: z.string(), address: z.string() })),
});
export type EmailStatusView = z.infer<typeof emailStatusViewSchema>;

/** Capabilities by name, as you pick them; each kind keeps only its own when saved. */
const capabilityNamesSchema = z.array(z.string().max(40)).max(20);

/** An MCP server to save: a new one, or with `id`, a change to one. */
export const connectionInputSchema = z.object({
  id: id.nullable(),
  label: z.string().trim().min(1, "Give it a name.").max(60),
  transport: z.enum(["http", "stdio"]),
  /** For http: the MCP endpoint. */
  url: z.string().trim().max(2000),
  /** For stdio: the command the computer runs, and its arguments as you'd type them. */
  command: z.string().trim().max(500),
  args: z.string().max(4000),
  /** Header lines (http) or NAME=value lines (stdio). Empty when editing keeps what's saved. */
  secrets: z.string().max(20_000),
  teammateIds: teammateAccessSchema,
});
export type ConnectionInput = z.infer<typeof connectionInputSchema>;

/** The OAuth client you made in a provider's console (Google's, in your Cloud project). */
export const oauthClientInputSchema = z.object({
  provider: accountProviderSchema,
  clientId: z.string().max(300),
  clientSecret: z.string().max(300),
});

/** What to sign in to a provider for. */
export const accountConnectInputSchema = z.object({
  kind: accountConnectionKindSchema,
  capabilities: capabilityNamesSchema,
  teammateIds: teammateAccessSchema,
  /** Sign in again as this account: to reconnect it, or to grant it more. */
  accountId: id.nullable(),
});

/** A change to what an account connection allows, who uses it and how it asks. */
export const accountConnectionChangesSchema = z.object({
  connectionId: id,
  capabilities: capabilityNamesSchema,
  teammateIds: teammateAccessSchema,
  askBeforeActing: z.boolean(),
  /** The integration's settings as you typed them, by key: "" clears one, a missing key keeps it. */
  settings: z.record(z.string().max(60), z.string().max(2000)).optional(),
});

/** Your teammates' email domain, and Postmark's server token; an empty token keeps the saved one. */
export const emailSettingsInputSchema = z.object({
  domain: z.string().max(300),
  token: z.string().max(200),
});
