import "server-only";
import type { ApiInputs, ApiOutputs } from "@open-bot/api";
import { bots as teammates, connections, credentials, emailSettings } from "@open-bot/db";
import {
  connectionName,
  invalidMcpUrl,
  normalizeDomain,
  parseEnvLines,
  parseHeaderLines,
  type AccountCapability,
} from "@open-bot/domain";
import { encryptSecret, secretHint } from "@open-bot/domain/server";
import { eq, isNull } from "drizzle-orm";
import {
  removeAccountConnection,
  saveOwnerClient,
  setAccountConnectionEnabled,
  startAuthorization,
  updateAccountConnection,
} from "../accounts";
import { claimConnectionName } from "../connection-names";
import { db } from "../db";
import { serverEnv } from "../env";
import { publish } from "../publish";
import { emailSettingsRow } from "../queries";
import { worker } from "../worker";
import { ApiError } from "./errors";
import { syncWorkspace } from "./teammates";

/** Connections, accounts and email: what teammates use outside the computer. */

type Inputs = ApiInputs;
type Ok = { ok: true };

/* ------------------------------------------------------------------ Email */

/**
 * Your teammates' email: the domain their addresses are on, and Postmark's server token, which
 * sends what they write. A token left empty keeps the saved one.
 */
export async function saveEmailSettings(input: Inputs["email"]["save"]): Promise<Ok> {
  const domain = input.domain.trim() ? normalizeDomain(input.domain) : null;
  if (input.domain.trim() && !domain)
    throw new ApiError("BAD_REQUEST", "Give a domain, like team.example.com.");
  const token = input.token.trim();
  if (token && !/^[\w-]{20,80}$/.test(token))
    throw new ApiError("BAD_REQUEST", "That doesn't look like a Postmark server token.");
  await emailSettingsRow();
  await db.update(emailSettings).set({ domain }).where(eq(emailSettings.id, 1));
  if (token) {
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
  const team = await db
    .select({ id: teammates.id })
    .from(teammates)
    .where(isNull(teammates.archivedAt));
  for (const teammate of team) await syncWorkspace(teammate.id);
  return { ok: true };
}

export async function removeEmailToken(): Promise<Ok> {
  await db.delete(credentials).where(eq(credentials.kind, "postmark_token"));
  await publish({ type: "email" });
  return { ok: true };
}

/* ------------------------------------------------------------------ MCP connections */

/** "a b 'c d'" as arguments, keeping quoted ones together. */
function splitArgs(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
}

/** Save a service teammates use through MCP. Headers and variables are encrypted here. */
export async function saveConnection(
  input: Inputs["connections"]["save"],
): Promise<{ id: string }> {
  if (input.transport === "http") {
    const problem = invalidMcpUrl(input.url);
    if (problem) throw new ApiError("BAD_REQUEST", problem);
  } else if (!input.command)
    throw new ApiError("BAD_REQUEST", "Give the command the computer runs.");
  const parsed = input.secrets.trim()
    ? input.transport === "http"
      ? parseHeaderLines(input.secrets)
      : parseEnvLines(input.secrets)
    : null;
  if (typeof parsed === "string") throw new ApiError("BAD_REQUEST", parsed);

  const saved = await db.transaction(async (tx) => {
    const [existing] = input.id
      ? await tx.select().from(connections).where(eq(connections.id, input.id)).for("update")
      : [];
    if (input.id && !existing) throw new ApiError("NOT_FOUND", "That connection is gone.");
    if (existing && existing.kind !== "mcp")
      throw new ApiError("BAD_REQUEST", "That's an account, not an MCP server.");
    const name = existing?.name ?? (await claimConnectionName(tx, connectionName(input.label)));
    // Without new secrets, an edit keeps the saved ones, unless the kind of connection changed.
    const keep = !parsed && existing && existing.transport === input.transport;
    const secrets = parsed
      ? input.transport === "http"
        ? { headers: parsed }
        : { env: parsed }
      : null;
    const values = {
      label: input.label,
      name,
      transport: input.transport,
      url: input.transport === "http" ? input.url : null,
      command: input.transport === "stdio" ? input.command : null,
      args: input.transport === "stdio" ? splitArgs(input.args) : [],
      botIds: input.teammateIds,
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
      ? await tx
          .update(connections)
          .set(values)
          .where(eq(connections.id, existing.id))
          .returning({ id: connections.id })
      : await tx.insert(connections).values(values).returning({ id: connections.id });
    return row!;
  });
  await publish({ type: "connections" });
  return saved;
}

async function connectionKind(connectionId: string) {
  const [row] = await db
    .select({ kind: connections.kind })
    .from(connections)
    .where(eq(connections.id, connectionId));
  return row?.kind ?? null;
}

export async function setConnectionEnabled({
  connectionId,
  enabled,
}: Inputs["connections"]["setEnabled"]): Promise<Ok> {
  const kind = await connectionKind(connectionId);
  if (!kind) throw new ApiError("NOT_FOUND", "That connection is gone.");
  if (kind !== "mcp") await setAccountConnectionEnabled(connectionId, enabled);
  else {
    await db.update(connections).set({ enabled }).where(eq(connections.id, connectionId));
    await publish({ type: "connections" });
  }
  return { ok: true };
}

/**
 * Remove a connection. For an account, the last connection using it also revokes its access at
 * the provider; the warning says when that couldn't be done.
 */
export async function removeConnection({
  connectionId,
}: Inputs["connections"]["remove"]): Promise<ApiOutputs["connections"]["remove"]> {
  const kind = await connectionKind(connectionId);
  if (!kind) return { warning: null };
  if (kind !== "mcp") return removeAccountConnection(connectionId);
  await db.delete(connections).where(eq(connections.id, connectionId));
  await publish({ type: "connections" });
  return { warning: null };
}

/** Connect to the service from the computer, and list what it offers. */
export async function testConnection({
  connectionId,
}: Inputs["connections"]["test"]): Promise<ApiOutputs["connections"]["test"]> {
  return worker.connections.test({ connectionId }, { context: { timeoutMs: 90_000 } });
}

/* ------------------------------------------------------------------ Accounts */

/** Save the OAuth client you made in a provider's console (Google's, in your Cloud project). */
export async function saveOAuthClient(input: Inputs["accounts"]["saveClient"]): Promise<Ok> {
  await saveOwnerClient(input);
  return { ok: true };
}

/** Start connecting an account, tied to this session. Returns the provider's sign-in page. */
export async function startAccountConnect(
  input: Inputs["accounts"]["connect"],
  sessionId: string,
): Promise<{ url: string }> {
  const url = await startAuthorization({
    sessionId,
    kind: input.kind,
    // Each kind keeps only its own (`normalizeCapabilities`), so unknown names drop out there.
    capabilities: input.capabilities as AccountCapability[],
    botIds: input.teammateIds,
    accountId: input.accountId,
  });
  return { url };
}

/**
 * Change what an account connection allows and who uses it. When it allows more than the account
 * granted, nothing changes and `needsConsent` says to sign in again for it.
 */
export async function saveAccountConnection(
  input: Inputs["accounts"]["update"],
): Promise<{ needsConsent: boolean }> {
  return updateAccountConnection({
    id: input.connectionId,
    capabilities: input.capabilities as AccountCapability[],
    botIds: input.teammateIds,
    askBeforeActing: input.askBeforeActing,
    settings: input.settings,
  });
}
