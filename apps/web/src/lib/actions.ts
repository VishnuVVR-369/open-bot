"use server";

import {
  bots,
  credentials,
  instructionProposals,
  settings,
  vaultItems,
  connections,
  emailSettings,
} from "@open-bot/db";
import {
  isAccountConnectionKind,
  isAccountProvider,
  isValidTimeZone,
  cardHint,
  connectionName,
  invalidCard,
  invalidMcpUrl,
  parseEnvLines,
  parseHeaderLines,
  normalizeDomain,
  normalizeExpiry,
  toCents,
  type AccountCapability,
  type AccountConnectionKind,
  type AccountProvider,
  type CardSecret,
  type LoginSecret,
  type Autonomy,
} from "@open-bot/domain";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { decryptSecret, encryptSecret, secretHint } from "@open-bot/domain/server";
import { memoryInputSchema, memoryEditSchema, memoryReferenceSchema } from "@open-bot/domain";
import { memoryReady } from "./server/memory";
import { publish } from "./server/publish";
import { db, pool } from "./server/db";
import { serverEnv } from "./server/env";
import { getSession, requireUser } from "./server/session";
import {
  removeAccountConnection,
  saveOwnerClient,
  setAccountConnectionEnabled,
  startAuthorization,
  updateAccountConnection,
} from "./server/accounts";
import { syncWorkspace } from "./server/api/teammates";
import { emailSettingsRow } from "./server/queries";
import { worker } from "./server/worker";

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

async function guarded<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  await requireUser();
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    if (error instanceof z.ZodError)
      return { ok: false, error: error.issues.map((i) => i.message).join(". ") };
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/* ------------------------------------------------------------------ Lessons */

export async function deleteLesson(id: string) {
  return guarded(async () => {
    const store = await memoryReady();
    const { rows } = await pool.query<{ revision: number }>(
      "select revision from memory_items where id=$1 and state<>'deleted'",
      [z.string().uuid().parse(id)],
    );
    if (rows[0]) await store.forget({ id, expectedRevision: rows[0].revision }, { kind: "user" });
  });
}

/* ------------------------------------------------------------------ Suggested instructions */

/** Takes a teammate's suggested instructions; they apply from its next message. */
export async function acceptProposal(proposalId: string) {
  return guarded(async () => {
    const botId = await db.transaction(async (tx) => {
      const [proposal] = await tx
        .update(instructionProposals)
        .set({ status: "accepted", decidedAt: new Date() })
        .where(
          and(
            eq(instructionProposals.id, z.string().uuid().parse(proposalId)),
            eq(instructionProposals.status, "pending"),
          ),
        )
        .returning();
      if (!proposal) throw new Error("That suggestion was already handled.");
      await tx
        .update(bots)
        .set({ instructions: proposal.proposed })
        .where(eq(bots.id, proposal.botId));
      return proposal.botId;
    });
    await syncWorkspace(botId);
    await publish({ type: "bots" });
  });
}

export async function dismissProposal(proposalId: string) {
  return guarded(async () => {
    await db
      .update(instructionProposals)
      .set({ status: "dismissed", decidedAt: new Date() })
      .where(
        and(
          eq(instructionProposals.id, z.string().uuid().parse(proposalId)),
          eq(instructionProposals.status, "pending"),
        ),
      );
    await publish({ type: "bots" });
  });
}

/* ------------------------------------------------------------------ Vault */

const vaultInput = z.object({
  id: z.string().uuid().nullable(),
  kind: z.enum(["login", "card"]),
  name: z.string().trim().min(1, "Give it a name.").max(80),
  domain: z.string().max(300).default(""),
  /** The teammates that may use it, or null for every teammate. */
  botIds: z.array(z.string().uuid()).nullable(),
  /** Fields left empty when editing keep what's saved. */
  secret: z.record(z.string(), z.string().max(500)),
});

/** Save a login or card. Secrets are encrypted here and never sent back to the browser. */
export async function saveVaultItem(input: z.input<typeof vaultInput>) {
  return guarded(async () => {
    const data = vaultInput.parse(input);
    if (data.botIds?.length === 0) throw new Error("Pick at least one teammate, or everyone.");
    const [existing] = data.id
      ? await db.select().from(vaultItems).where(eq(vaultItems.id, data.id))
      : [];
    if (data.id && !existing) throw new Error("That item is no longer in the vault.");
    if (existing && existing.kind !== data.kind) throw new Error("An item can't change its kind.");
    const saved = existing
      ? (JSON.parse(decryptSecret(existing.encrypted, serverEnv.encryptionKey)) as Record<
          string,
          string
        >)
      : {};
    const merged: Record<string, string> = { ...saved };
    for (const [field, value] of Object.entries(data.secret))
      if (value.trim()) merged[field] = value;

    let secret: LoginSecret | CardSecret;
    let hint: string;
    let domain: string | null = null;
    if (data.kind === "login") {
      domain = normalizeDomain(data.domain);
      if (!domain) throw new Error("Give the site it's for, like github.com.");
      const username = (data.secret.username ?? merged.username ?? "").trim();
      const password = merged.password ?? "";
      if (!username) throw new Error("Add the username or email.");
      if (!password) throw new Error("Add the password.");
      secret = { username, password };
      hint = username;
    } else {
      const card: CardSecret = {
        number: (merged.number ?? "").replace(/[\s-]/g, ""),
        expiry: normalizeExpiry(merged.expiry ?? "") ?? merged.expiry ?? "",
        cvc: (merged.cvc ?? "").trim(),
        name: (merged.name ?? "").trim(),
        zip: (merged.zip ?? "").trim(),
      };
      const problem = invalidCard(card);
      if (problem) throw new Error(problem);
      secret = card;
      hint = cardHint(card.number);
    }
    const values = {
      kind: data.kind,
      name: data.name,
      domain,
      hint,
      botIds: data.botIds,
      encrypted: encryptSecret(JSON.stringify(secret), serverEnv.encryptionKey),
    };
    if (existing) await db.update(vaultItems).set(values).where(eq(vaultItems.id, existing.id));
    else await db.insert(vaultItems).values(values);
    await publish({ type: "vault" });
  });
}

export async function deleteVaultItem(id: string) {
  return guarded(async () => {
    await db.delete(vaultItems).where(eq(vaultItems.id, z.string().uuid().parse(id)));
    await publish({ type: "vault" });
  });
}

/** A teammate's monthly budget, in dollars, or null so it can't pay at all. */
export async function setBudget(
  botId: string,
  input: { budget: number | null; autoApprove: number },
) {
  return guarded(async () => {
    const budgetCents = input.budget === null ? null : toCents(input.budget);
    if (input.budget !== null && budgetCents === null)
      throw new Error("Give the budget in dollars, like 100.");
    if (budgetCents !== null && budgetCents > 10_000_000)
      throw new Error("Keep the budget under $100,000.");
    const autoApproveCents = input.autoApprove > 0 ? (toCents(input.autoApprove) ?? 0) : 0;
    if (budgetCents !== null && autoApproveCents > budgetCents)
      throw new Error("The amount to approve on its own can't be more than the budget.");
    await db
      .update(bots)
      .set({ monthlyBudgetCents: budgetCents, autoApproveCents })
      .where(eq(bots.id, z.string().uuid().parse(botId)));
    await publish({ type: "purchases" });
  });
}

/* ------------------------------------------------------------------ Email */

/**
 * Your teammates' email: the domain their addresses are on, and Postmark's server token, which
 * sends what they write. A token left empty keeps the saved one.
 */
export async function saveEmailSettings(input: { domain: string; token: string }) {
  return guarded(async () => {
    const domain = input.domain.trim() ? normalizeDomain(input.domain) : null;
    if (input.domain.trim() && !domain) throw new Error("Give a domain, like team.example.com.");
    await emailSettingsRow();
    await db.update(emailSettings).set({ domain }).where(eq(emailSettings.id, 1));
    const token = input.token.trim();
    if (token) {
      if (!/^[\w-]{20,80}$/.test(token))
        throw new Error("That doesn't look like a Postmark server token.");
      const encrypted = encryptSecret(token, serverEnv.encryptionKey);
      await db
        .insert(credentials)
        .values({ kind: "postmark_token", encrypted, hint: secretHint(token) })
        .onConflictDoUpdate({
          target: credentials.kind,
          set: { encrypted, hint: secretHint(token) },
        });
    }
    await publish({ type: "email" });
    // Teammates learn their address in their instructions.
    for (const bot of await db.select({ id: bots.id }).from(bots).where(isNull(bots.archivedAt)))
      await syncWorkspace(bot.id).catch(() => {});
  });
}

export async function removeEmailToken() {
  return guarded(async () => {
    await db.delete(credentials).where(eq(credentials.kind, "postmark_token"));
    await publish({ type: "email" });
  });
}

/* ------------------------------------------------------------------ Connections */

const connectionInput = z.object({
  id: z.string().uuid().nullable(),
  label: z.string().trim().min(1, "Give it a name.").max(60),
  transport: z.enum(["http", "stdio"]),
  url: z.string().trim().max(2000).default(""),
  command: z.string().trim().max(500).default(""),
  args: z.string().max(4000).default(""),
  /** Header lines (http) or NAME=value lines (stdio). Empty when editing keeps what's saved. */
  secrets: z.string().max(20_000).default(""),
  botIds: z.array(z.string().uuid()).nullable(),
});

/** Save a service teammates use through MCP. Headers and variables are encrypted here. */
export async function saveConnection(input: z.input<typeof connectionInput>) {
  return guarded(async () => {
    const data = connectionInput.parse(input);
    if (data.botIds?.length === 0) throw new Error("Pick at least one teammate, or everyone.");
    if (data.transport === "http") {
      const problem = invalidMcpUrl(data.url);
      if (problem) throw new Error(problem);
    } else if (!data.command) throw new Error("Give the command the computer runs.");
    const parsed = data.secrets.trim()
      ? data.transport === "http"
        ? parseHeaderLines(data.secrets)
        : parseEnvLines(data.secrets)
      : null;
    if (typeof parsed === "string") throw new Error(parsed);
    const [existing] = data.id
      ? await db.select().from(connections).where(eq(connections.id, data.id))
      : [];
    if (data.id && !existing) throw new Error("That connection is gone.");
    const name = existing?.name ?? (await uniqueConnectionName(connectionName(data.label)));
    // Without new secrets, an edit keeps the saved ones, unless the kind of connection changed.
    const keep = !parsed && existing && existing.transport === data.transport;
    const secrets = parsed
      ? data.transport === "http"
        ? { headers: parsed }
        : { env: parsed }
      : null;
    const values = {
      label: data.label,
      name,
      transport: data.transport,
      url: data.transport === "http" ? data.url : null,
      command: data.transport === "stdio" ? data.command : null,
      args: data.transport === "stdio" ? splitArgs(data.args) : [],
      botIds: data.botIds,
      ...(keep
        ? {}
        : {
            encrypted: secrets
              ? encryptSecret(JSON.stringify(secrets), serverEnv.encryptionKey)
              : null,
            secretNames: parsed ? Object.keys(parsed) : [],
          }),
    };
    const [row] = existing
      ? await db.update(connections).set(values).where(eq(connections.id, existing.id)).returning()
      : await db.insert(connections).values(values).returning();
    await publish({ type: "connections" });
    return { id: row!.id };
  });
}

/** "a b 'c d'" as arguments, keeping quoted ones together. */
function splitArgs(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
}

async function uniqueConnectionName(base: string): Promise<string> {
  const taken = new Set(
    (await db.select({ name: connections.name }).from(connections)).map((row) => row.name),
  );
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}_${n}`;
  return name;
}

export async function setConnectionEnabled(id: string, enabled: boolean) {
  return guarded(async () => {
    const [row] = await db
      .select({ kind: connections.kind })
      .from(connections)
      .where(eq(connections.id, z.string().uuid().parse(id)));
    if (!row) throw new Error("That connection is gone.");
    if (row.kind !== "mcp") return setAccountConnectionEnabled(id, enabled);
    await db.update(connections).set({ enabled }).where(eq(connections.id, id));
    await publish({ type: "connections" });
  });
}

/**
 * Remove a connection. For an account, the last connection using it also revokes its access at
 * the provider; the warning says when that couldn't be done.
 */
export async function deleteConnection(id: string) {
  return guarded(async (): Promise<{ warning: string | null }> => {
    const [row] = await db
      .select({ kind: connections.kind })
      .from(connections)
      .where(eq(connections.id, z.string().uuid().parse(id)));
    if (!row) return { warning: null };
    if (row.kind !== "mcp") return removeAccountConnection(id);
    await db.delete(connections).where(eq(connections.id, id));
    await publish({ type: "connections" });
    return { warning: null };
  });
}

/* ------------------------------------------------------------------ Accounts */

const accountProvider = z
  .string()
  .refine(isAccountProvider, "Unknown provider.")
  .transform((value) => value as AccountProvider);
const accountKind = z
  .string()
  .refine(isAccountConnectionKind, "Unknown kind of account.")
  .transform((value) => value as AccountConnectionKind);
/** Capabilities by name; each kind keeps only its own (`normalizeCapabilities`). */
const accountCapabilities = z
  .array(z.string().max(40))
  .max(20)
  .transform((value) => value as AccountCapability[]);

const oauthClientInput = z.object({
  provider: accountProvider,
  clientId: z.string().max(300),
  clientSecret: z.string().max(300),
});

/** Save the OAuth client you made in a provider's console (Google's, in your Cloud project). */
export async function saveOAuthClient(input: z.input<typeof oauthClientInput>) {
  return guarded(async () => saveOwnerClient(oauthClientInput.parse(input)));
}

const accountConnectInput = z.object({
  kind: accountKind,
  capabilities: accountCapabilities,
  botIds: z.array(z.string().uuid()).nullable(),
  /** Sign in again as this account: to reconnect it, or to grant it more. */
  accountId: z.string().uuid().nullable(),
});

/** Start connecting an account. Returns the provider's sign-in page to go to. */
export async function startAccountConnect(input: z.input<typeof accountConnectInput>) {
  return guarded(async () => {
    const data = accountConnectInput.parse(input);
    if (data.botIds?.length === 0) throw new Error("Pick at least one teammate, or everyone.");
    const session = await getSession();
    if (!session) throw new Error("Sign in again.");
    const url = await startAuthorization({ sessionId: session.session.id, ...data });
    return { url };
  });
}

const accountConnectionInput = z.object({
  id: z.string().uuid(),
  capabilities: accountCapabilities,
  botIds: z.array(z.string().uuid()).nullable(),
  askBeforeActing: z.boolean(),
  /** The integration's settings as you typed them, by key: "" clears one, a missing key keeps it. */
  settings: z.record(z.string().max(60), z.string().max(2000)).optional(),
});

/**
 * Change what an account connection allows and who uses it. When it allows more than the account
 * granted, nothing changes and `needsConsent` says to sign in again for it.
 */
export async function saveAccountConnection(input: z.input<typeof accountConnectionInput>) {
  return guarded(async () => {
    const data = accountConnectionInput.parse(input);
    if (data.botIds?.length === 0) throw new Error("Pick at least one teammate, or everyone.");
    return updateAccountConnection(data);
  });
}

/** Connect to the service from the computer, and list what it offers. */
export async function testConnection(id: string) {
  return guarded(async () =>
    worker.connections.test({ connectionId: id }, { context: { timeoutMs: 90_000 } }),
  );
}

/* ------------------------------------------------------------------ Settings */

export async function setTimezone(timezone: string) {
  return guarded(async () => {
    if (!isValidTimeZone(timezone)) throw new Error("Unknown timezone.");
    await db.update(settings).set({ timezone }).where(eq(settings.id, 1));
  });
}

export async function getSettings() {
  return guarded(async () => {
    const [row] = await db.select().from(settings).where(eq(settings.id, 1));
    return { timezone: row?.timezone ?? "UTC", monthlyCapMicros: row?.monthlyCapMicros ?? 0 };
  });
}

/* ------------------------------------------------------------------ When the plan runs out */

export async function saveApiKey(apiKey: string) {
  return guarded(async () => {
    const key = z
      .string()
      .trim()
      .regex(
        /^sk-[A-Za-z0-9_-]{20,}$/,
        "That doesn't look like an OpenAI API key. It starts with sk-.",
      )
      .parse(apiKey);
    const encrypted = encryptSecret(key, serverEnv.encryptionKey);
    await db
      .insert(credentials)
      .values({ kind: "openai_api_key", encrypted, hint: secretHint(key) })
      .onConflictDoUpdate({ target: credentials.kind, set: { encrypted, hint: secretHint(key) } });
    await publish({ type: "auth" });
  });
}

export async function removeApiKey() {
  return guarded(async () => {
    await db.delete(credentials).where(eq(credentials.kind, "openai_api_key"));
    await publish({ type: "auth" });
  });
}

export async function setMonthlyCap(dollars: number) {
  return guarded(async () => {
    const value = z.number().min(0, "The cap can't be negative.").max(10_000).parse(dollars);
    await db
      .update(settings)
      .set({ monthlyCapMicros: Math.round(value * 1_000_000) })
      .where(eq(settings.id, 1));
    await publish({ type: "auth" });
  });
}

export type { Autonomy };

/* ------------------------------------------------------------------ Versioned memory */
export async function createMemoryItem(input: unknown) {
  return guarded(async () =>
    (await memoryReady()).save(memoryInputSchema.parse(input), { kind: "user" }),
  );
}
export async function editMemoryItem(input: unknown) {
  return guarded(async () =>
    (await memoryReady()).update(memoryEditSchema.parse(input), { kind: "user" }),
  );
}
export async function forgetMemoryItem(input: unknown) {
  return guarded(async () =>
    (await memoryReady()).forget(memoryReferenceSchema.parse(input), { kind: "user" }),
  );
}
export async function confirmMemoryItem(input: unknown) {
  return guarded(async () => (await memoryReady()).approve(memoryReferenceSchema.parse(input)));
}
export async function restoreMemoryItem(input: {
  id: string;
  expectedRevision: number;
  revision: number;
}) {
  return guarded(async () => {
    const data = memoryReferenceSchema
      .extend({ revision: z.number().int().positive() })
      .parse(input);
    return (await memoryReady()).restore(data);
  });
}
