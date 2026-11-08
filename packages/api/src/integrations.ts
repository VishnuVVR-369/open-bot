import {
  ACCOUNT_CONNECTION_KINDS,
  ACCOUNT_PROVIDERS,
  ACCOUNT_STATUSES,
  type AccountCapability,
  type AccountConnectionKind,
  type AccountProvider,
} from "@open-bot/domain";
import { z } from "zod";

/** Integrations as Settings shows them: connections (MCP servers and accounts) and email. */

const isoDate = z.string();

export const accountProviderSchema = z.enum(
  ACCOUNT_PROVIDERS as [AccountProvider, ...AccountProvider[]],
);

export const connectionKindSchema = z.enum([
  "mcp",
  ...(ACCOUNT_CONNECTION_KINDS as [AccountConnectionKind, ...AccountConnectionKind[]]),
]);

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
