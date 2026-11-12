import {
  ACCOUNT_CONNECTION_KINDS,
  accountTool,
  integration,
  integrationByNamespace,
  type AccountConnectionKind,
} from "@open-bot/domain";
import type { IntegrationAdapter, IntegrationAdapterClass, IntegrationHost } from "./core/adapter";
import type { NamespaceSpec } from "./core/tool-spec";
import { CalendarTools } from "./providers/google/calendar/adapter";
import { GmailTools } from "./providers/google/gmail/adapter";
import { NotionTools } from "./providers/notion/adapter";

/**
 * Every integration's adapter, one line each. Adding an integration is its definition in
 * `@open-bot/domain`, its folder under `providers/`, and its class here; nothing else changes.
 */
const ADAPTERS: readonly IntegrationAdapterClass[] = [GmailTools, CalendarTools, NotionTools];

/** Why a namespace's tools don't match its integration's definition, or null. */
export function specProblem(spec: NamespaceSpec): string | null {
  const definition = integrationByNamespace(spec.name);
  if (!definition) return `No integration has the namespace "${spec.name}".`;
  const defined = new Set(definition.tools.map((entry) => entry.name));
  const served = new Set(spec.tools.map((entry) => entry.name));
  const missing = [...defined].filter((name) => !served.has(name));
  const extra = [...served].filter((name) => !defined.has(name));
  if (missing.length || extra.length)
    return `${definition.label}'s tools don't match its definition${missing.length ? `; missing ${missing.join(", ")}` : ""}${extra.length ? `; not defined ${extra.join(", ")}` : ""}.`;
  return null;
}

function checked(classes: readonly IntegrationAdapterClass[]): NamespaceSpec[] {
  const specs = classes.map((adapter) => adapter.spec);
  for (const spec of specs) {
    const problem = specProblem(spec);
    if (problem) throw new Error(problem);
  }
  const names = specs.map((spec) => spec.name);
  const missing = ACCOUNT_CONNECTION_KINDS.filter(
    (kind) => !names.includes(integration(kind).namespace),
  );
  if (missing.length) throw new Error(`No worker adapter for ${missing.join(", ")}.`);
  if (new Set(names).size !== names.length) throw new Error("Two adapters serve one namespace.");
  return specs;
}

/** The account tools every thread gets; access is checked per call. */
export const ACCOUNT_TOOL_SPECS: readonly NamespaceSpec[] = checked(ADAPTERS);

/** Whether a namespace is one of an integration's (the tool call goes to the integrations). */
export function isAccountNamespace(namespace: string): boolean {
  return integrationByNamespace(namespace) !== undefined;
}

/** The adapters, one per integration, by kind. */
export class Integrations {
  private readonly byKind = new Map<AccountConnectionKind, IntegrationAdapter>();

  constructor(adapters: readonly IntegrationAdapter[]) {
    for (const adapter of adapters) {
      if (this.byKind.has(adapter.kind)) throw new Error(`Two adapters for ${adapter.kind}.`);
      this.byKind.set(adapter.kind, adapter);
    }
  }

  static create(host: IntegrationHost): Integrations {
    return new Integrations(
      ADAPTERS.map((Adapter) => {
        const adapter = new Adapter(host);
        if (integration(adapter.kind).namespace !== Adapter.spec.name)
          throw new Error(`${adapter.kind}'s adapter serves the wrong namespace.`);
        return adapter;
      }),
    );
  }

  get(kind: AccountConnectionKind): IntegrationAdapter {
    const adapter = this.byKind.get(kind);
    if (!adapter) throw new Error(`No adapter for ${kind}.`);
    return adapter;
  }

  /** Releases every adapter's timers and connections, at shutdown. */
  async stop(): Promise<void> {
    await Promise.all([...this.byKind.values()].map((adapter) => adapter.stop?.()));
  }

  /** The adapter of the integration a tool (`namespace.tool`) belongs to. */
  forTool(tool: string): IntegrationAdapter | undefined {
    const info = accountTool(tool);
    return info ? this.byKind.get(info.kind) : undefined;
  }
}
