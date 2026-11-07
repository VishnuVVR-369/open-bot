import type { accountActions } from "@open-bot/db";
import type { AccountActionPreview, AccountConnectionKind, ActionEffect } from "@open-bot/shared";
import type { Context } from "../context";
import type { RunSession } from "../runs/session";
import type { AccountAccess, ResolvedConnection } from "./access";
import type { ProviderError, TokenSource } from "./http";
import type { NamespaceSpec } from "./schema";

export type ActionRow = typeof accountActions.$inferSelect;

/** A change to one of your accounts, worked out and frozen before anything is asked or done. */
export interface PreparedAction {
  /** `namespace.tool`, like `gmail.send_draft`. */
  tool: string;
  effect: ActionEffect;
  /** Exactly what the executor sends; what you approve is what runs. */
  request: Record<string, unknown>;
  /** One line on what it does: "Send “Lease renewal” to sam@example.com". */
  summary: string;
  /** More for the approval card, as plain text, for apps that can't render the preview. */
  detail: string;
  preview: AccountActionPreview | null;
  /** The timeline label while it waits for you, and once it's done. */
  labels: { waiting: string; done: string; failed: string };
}

/** What happened when the executor ran an action. */
export type ActionOutcome =
  | {
      status: "done";
      /** What the teammate is told. */
      message: string;
      result?: Record<string, unknown>;
      providerRef?: Record<string, unknown>;
    }
  | { status: "failed"; error: string }
  /** It may or may not have happened; never retried blindly. */
  | { status: "unknown"; error: string; providerRef?: Record<string, unknown> }
  /** The provider is still working on it (Notion's asynchronous tasks). */
  | { status: "waiting"; providerRef: Record<string, unknown>; checkAfterMs: number };

/** Runs one integration's actions, for the executor. */
export interface ActionRunner {
  execute(
    action: ActionRow,
    tokens: TokenSource,
    resolved: ResolvedConnection,
  ): Promise<ActionOutcome>;
  /**
   * The worker stopped, or lost the answer, while an action ran: find out whether it happened.
   * "not_done" means it certainly didn't, so running it again is safe; null means it can't tell.
   */
  reconcile(
    action: ActionRow,
    tokens: TokenSource,
    resolved: ResolvedConnection,
  ): Promise<ActionOutcome | "not_done" | null>;
  /** Look again at an action the provider is still working on. */
  poll?(
    action: ActionRow,
    tokens: TokenSource,
    resolved: ResolvedConnection,
  ): Promise<ActionOutcome>;
  /** After it's done: remember what it made (Notion pages teammates own). */
  done?(action: ActionRow, outcome: Extract<ActionOutcome, { status: "done" }>): Promise<void>;
}

/** What an integration's tool handlers get. */
export interface ToolContext {
  session: RunSession;
  resolved: ResolvedConnection;
  tokens: TokenSource;
  access: AccountAccess;
  args: Record<string, unknown>;
  /** The id the action will get, known up front so requests can carry it. */
  actionId: string;
}

/** A tool's answer: text for a read, or an action to submit. */
export type ToolResult =
  | {
      type: "read";
      text: string;
      /** The timeline label, like `Searched Gmail: from:sam`. */
      label: string;
      /** A short summary under the label. */
      summary?: string;
      /** It returned text from outside (mail, events, pages) that the teammate now has. */
      outside: boolean;
    }
  | { type: "action"; action: PreparedAction };

/**
 * One integration in the worker: its tools, and how they read and change the service. What every
 * integration shares (access checks, approvals, the durable executor, outside-data marking) is
 * done around it, so an adapter only knows its own service.
 */
export interface IntegrationAdapter {
  readonly kind: AccountConnectionKind;
  /** Reads answer; changes come back as actions for the executor. */
  call(tool: string, tc: ToolContext): Promise<ToolResult>;
  /** One cheap real call that proves the connection works, for Settings' Test: "Signed in as…". */
  probe(resolved: ResolvedConnection, tokens: TokenSource): Promise<string>;
  /** A refusal from the service, said for the teammate, with the fix where there is one. */
  problem(error: ProviderError): string;
  readonly runner: ActionRunner;
  /** Releases timers and connections at shutdown, for adapters that hold any. */
  stop?(): Promise<void>;
}

/** An adapter's class: its tools are known before any instance, since every thread gets them. */
export interface IntegrationAdapterClass {
  new (ctx: Context): IntegrationAdapter;
  /** The tools teammates see, in the integration's namespace. Named as shared's definition names them. */
  readonly spec: NamespaceSpec;
}
