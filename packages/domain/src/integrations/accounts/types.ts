/**
 * The shapes every integration is described in. An integration (Gmail, Google Calendar, Notion)
 * is a service teammates use as you; it signs in through an auth provider (Google, Notion), and
 * one signed-in account at a provider can serve several integrations.
 */

/** How a teammate's action reaches the world, which decides whether it asks you first. */
export type ActionEffect = "read" | "private_write" | "write" | "outward";

export type AccountStatus = "connected" | "needs_reconnect" | "revoked";

/** A sign-in service, like Google or Notion. */
export interface AuthProviderDefinition {
  id: string;
  /** "Google" */
  label: string;
  /** What one sign-in gives you: "Google account", "Notion workspace". */
  accountLabel: string;
  /**
   * Where the OAuth client comes from: `owner` is one you create in the provider's developer
   * console and paste into Settings; `automatic` is registered by open-bot itself.
   */
  client: "owner" | "automatic";
  /** Scopes every sign-in asks for, whatever the integration (who you are). */
  baseScopes: readonly string[];
  /** Other names the provider reports for a scope, mapped to the one asked for. */
  scopeAliases?: Readonly<Record<string, string>>;
  /** A grant ends this many days after you signed in, however much it's used. */
  grantMaxDays?: number;
  /** A grant ends after this many days without a refresh. */
  idleExpiryDays?: number;
  /** Where to remove open-bot by hand, when revoking couldn't reach the provider. */
  revokeHint: string;
}

/** One thing you can let teammates do with an integration, and what it needs granted. */
export interface CapabilityOption<C extends string = string> {
  capability: C;
  label: string;
  description: string;
  /** Always on: the connection is useless without it. */
  required?: boolean;
  /** On when you connect, unless you switch it off. */
  defaultOn: boolean;
  /** What the teammate is told it can do, in AGENTS.md. */
  can: string;
  /** A few words for Settings' summary of a connection: "drafts and sends". */
  short: string;
  /** The scopes to ask the provider for. None means signing in is enough. */
  scopes?: readonly string[];
  /** It's granted when any of these was (a broader scope can cover it). Default: `scopes`. */
  grantedBy?: readonly string[];
}

/** One tool teammates call, as the apps need to know it. The worker defines its schema. */
export interface IntegrationToolDefinition<C extends string = string> {
  /** Its name in the integration's namespace, like `search`. */
  name: string;
  /** What it does, for "Always allow" and the rules list: "Search Gmail". */
  label: string;
  /** The capability it needs. */
  capability: C;
}

/** A value you set on a connection, like Notion's teammates' area: a thing at the provider. */
export interface ConnectionSettingValue {
  id: string;
  title: string;
  url: string | null;
}

/** A connection's settings, by the integration's setting keys. */
export type ConnectionSettings = Partial<Record<string, ConnectionSettingValue>>;

/** A setting an integration offers on its connections, entered as text (a link, usually). */
export interface IntegrationSetting {
  key: string;
  label: string;
  placeholder: string;
  /** Under the field. */
  help: string;
  /** Said when `parse` refuses what you typed. */
  invalid: string;
  /** What Settings' summary calls it: "area". */
  noun: string;
  /** What you typed, as a value; null when it can't be one. */
  parse(input: string): ConnectionSettingValue | null;
  /** What the teammate is told about it, in AGENTS.md. */
  instruct(value: ConnectionSettingValue): string;
}

/** The icons the apps know, by name; each app maps them to its own icon set. */
export type IntegrationIcon = "mail" | "calendar" | "notebook";

/** A service teammates use as you, through one of your accounts at its provider. */
export interface IntegrationDefinition<C extends string = string> {
  /** The connection's kind, stored on it. */
  kind: string;
  /** The auth provider it signs in through. */
  provider: string;
  /** The tools' namespace, as teammates call them: `gmail.search`. */
  namespace: string;
  label: string;
  description: string;
  icon: IntegrationIcon;
  capabilities: readonly CapabilityOption<C>[];
  tools: readonly IntegrationToolDefinition<C>[];
  settings?: readonly IntegrationSetting[];
  /** How a teammate should use it, for AGENTS.md when it has the integration. */
  guidance?: readonly string[];
  /** Said before you sign in, when there's something worth knowing about the access it gives. */
  connectNote?: string;
}
