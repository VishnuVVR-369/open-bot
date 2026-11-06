import { GMAIL, GOOGLE, GOOGLE_CALENDAR } from "./google";
import { NOTION, NOTION_PROVIDER } from "./notion";
import type {
  AuthProviderDefinition,
  CapabilityOption,
  IntegrationDefinition,
  IntegrationSetting,
} from "./types";

/**
 * Every auth provider and integration open-bot knows. Adding one is adding its definition here
 * (and its adapters in the accounts package and the worker); the types, the scope checks, the
 * tool list and the apps' screens all follow from these.
 */

export const AUTH_PROVIDERS = {
  google: GOOGLE,
  notion: NOTION_PROVIDER,
} as const satisfies Record<string, AuthProviderDefinition>;

export type AccountProvider = keyof typeof AUTH_PROVIDERS;

/** Checks, at compile time, that each integration is filed under its own kind and a known provider. */
function defineIntegrations<T extends Record<string, IntegrationDefinition>>(
  definitions: T & { [K in keyof T]: { kind: K; provider: AccountProvider } },
): T {
  return definitions;
}

const DEFINITIONS = defineIntegrations({
  gmail: GMAIL,
  google_calendar: GOOGLE_CALENDAR,
  notion: NOTION,
});

/** A connection that uses one of your accounts. */
export type AccountConnectionKind = keyof typeof DEFINITIONS;

/** Every kind of connection: an MCP server you added, or one of your accounts. */
export type ConnectionKind = "mcp" | AccountConnectionKind;

/** What a connection lets teammates do, across every integration. `read` is always on. */
export type AccountCapability =
  (typeof DEFINITIONS)[AccountConnectionKind]["capabilities"][number]["capability"];

/** An integration, as the rest of the code reads it. */
export interface Integration extends IntegrationDefinition<AccountCapability> {
  kind: AccountConnectionKind;
  provider: AccountProvider;
}

export interface AuthProvider extends AuthProviderDefinition {
  id: AccountProvider;
}

export const INTEGRATIONS: Readonly<Record<AccountConnectionKind, Integration>> = DEFINITIONS;

export const ACCOUNT_CONNECTION_KINDS = Object.keys(INTEGRATIONS) as AccountConnectionKind[];

export const ACCOUNT_PROVIDERS = Object.keys(AUTH_PROVIDERS) as AccountProvider[];

export function isAccountConnectionKind(kind: string): kind is AccountConnectionKind {
  return Object.hasOwn(INTEGRATIONS, kind);
}

export function isAccountProvider(id: string): id is AccountProvider {
  return Object.hasOwn(AUTH_PROVIDERS, id);
}

export function integration(kind: AccountConnectionKind): Integration {
  return INTEGRATIONS[kind];
}

export function authProvider(id: AccountProvider): AuthProvider {
  return AUTH_PROVIDERS[id];
}

/** The integrations one sign-in at a provider serves. */
export function integrationsOf(provider: AccountProvider): Integration[] {
  return ACCOUNT_CONNECTION_KINDS.map(integration).filter((entry) => entry.provider === provider);
}

const BY_NAMESPACE = new Map(
  ACCOUNT_CONNECTION_KINDS.map((kind) => [INTEGRATIONS[kind].namespace, INTEGRATIONS[kind]]),
);

/** The integration whose tools live in this namespace, if any. */
export function integrationByNamespace(namespace: string): Integration | undefined {
  return BY_NAMESPACE.get(namespace);
}

export function capabilityOption(
  kind: AccountConnectionKind,
  capability: string,
): CapabilityOption<AccountCapability> | undefined {
  return INTEGRATIONS[kind].capabilities.find((option) => option.capability === capability);
}

/** The capability's name as you see it in Settings, or the capability itself. */
export function capabilityLabel(kind: AccountConnectionKind, capability: string): string {
  return capabilityOption(kind, capability)?.label ?? capability;
}

/** The capabilities you picked, with the required ones always included, in a stable order. */
export function normalizeCapabilities(
  kind: AccountConnectionKind,
  picked: readonly string[],
): AccountCapability[] {
  return INTEGRATIONS[kind].capabilities
    .filter((option) => option.required || picked.includes(option.capability))
    .map((option) => option.capability);
}

export function defaultCapabilities(kind: AccountConnectionKind): AccountCapability[] {
  return INTEGRATIONS[kind].capabilities
    .filter((option) => option.required || option.defaultOn)
    .map((option) => option.capability);
}

/**
 * The scopes to ask the provider for, for these capabilities. A broader scope a narrower one is
 * also asked for (gmail.modify and gmail.readonly) is kept, so turning a capability off later
 * doesn't need a new consent.
 */
export function scopesFor(kind: AccountConnectionKind, capabilities: readonly string[]): string[] {
  const wanted = normalizeCapabilities(kind, capabilities).flatMap(
    (capability) => capabilityOption(kind, capability)?.scopes ?? [],
  );
  return [...new Set([...authProvider(INTEGRATIONS[kind].provider).baseScopes, ...wanted])];
}

/** A space-separated scope string from a token response, as a clean list in the names asked for. */
export function parseScopes(provider: AccountProvider, scope: string | null | undefined): string[] {
  const aliases: Readonly<Record<string, string>> = authProvider(provider).scopeAliases ?? {};
  return [
    ...new Set(
      (scope ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map((entry) => aliases[entry] ?? entry),
    ),
  ];
}

/** Whether the granted scopes allow a capability. One that needs no scope only needs signing in. */
export function capabilityGranted(
  kind: AccountConnectionKind,
  capability: string,
  granted: readonly string[],
): boolean {
  const option = capabilityOption(kind, capability);
  if (!option) return false;
  const coveredBy = option.grantedBy ?? option.scopes ?? [];
  return coveredBy.length === 0 || coveredBy.some((scope) => granted.includes(scope));
}

/** The capabilities you picked that the provider didn't grant (you unticked them on its consent screen). */
export function missingCapabilities(
  kind: AccountConnectionKind,
  capabilities: readonly AccountCapability[],
  granted: readonly string[],
): AccountCapability[] {
  return capabilities.filter((capability) => !capabilityGranted(kind, capability, granted));
}

/** The settings an integration's connections take, like Notion's teammates' area. */
export function integrationSettings(kind: AccountConnectionKind): readonly IntegrationSetting[] {
  return INTEGRATIONS[kind].settings ?? [];
}

/** A tool teammates use on one of your accounts, as rules and timelines name it. */
export interface AccountToolInfo {
  /** `namespace.tool`, as the teammate calls it and as "Always allow" stores it. */
  name: string;
  kind: AccountConnectionKind;
  /** What it does, for "Always allow" and the rules list: "Update Notion pages". */
  label: string;
  /** The capability it needs. */
  capability: AccountCapability;
}

/** Every tool on your accounts. The worker defines their schemas; this is what the apps need. */
export const ACCOUNT_TOOLS: readonly AccountToolInfo[] = ACCOUNT_CONNECTION_KINDS.flatMap((kind) =>
  INTEGRATIONS[kind].tools.map((tool) => ({
    name: `${INTEGRATIONS[kind].namespace}.${tool.name}`,
    kind,
    label: tool.label,
    capability: tool.capability,
  })),
);

const TOOLS_BY_NAME = new Map(ACCOUNT_TOOLS.map((entry) => [entry.name, entry]));

export function accountTool(name: string): AccountToolInfo | undefined {
  return TOOLS_BY_NAME.get(name);
}
