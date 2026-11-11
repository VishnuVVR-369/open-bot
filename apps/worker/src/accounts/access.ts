import { AccountStore, AccountUnavailableError } from "@open-bot/accounts";
import { accounts, connections } from "@open-bot/db";
import {
  ACCOUNT_PROVIDERS,
  authProvider,
  capabilityGranted,
  capabilityLabel,
  capabilityOption,
  integration,
  integrationSettings,
  isAccountConnectionKind,
  type AccountCapability,
  type AccountConnectionKind,
} from "@open-bot/domain";
import { and, asc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import { publishApp, type Context } from "../context";
import { createNotification } from "../services/notifications";
import type { AccountAccessLine } from "../instructions";
import type { TokenSource } from "./http";

export type ConnectionRow = typeof connections.$inferSelect;
export type AccountRow = typeof accounts.$inferSelect;

/** A problem the teammate can act on (or tell the user about), said plainly. */
export class AccountToolError extends Error {
  constructor(
    message: string,
    /** The same problem said to you, as Settings shows it. */
    readonly ownerMessage: string = message,
  ) {
    super(message);
  }
}

/** One of your accounts, through the connection a teammate uses it with. */
export interface ResolvedConnection {
  kind: AccountConnectionKind;
  connection: ConnectionRow;
  account: AccountRow;
}

/** Usage is recorded at most this often per account. */
const TOUCH_EVERY_MS = 5 * 60_000;
/** A grant that ends when idle is refreshed once this much of its idle time has passed. */
const KEEP_ALIVE_AT = 2 / 3;
const DAY_MS = 24 * 60 * 60_000;

/** How an account is told apart from others of its kind, for the teammate. */
function described(option: ResolvedConnection): string {
  return `${option.account.display} (account "${option.connection.id}")`;
}

/**
 * Which of your accounts a teammate may use, and its tokens. Every account tool goes through
 * here, so access is checked on each call: threads keep their tools, but not their permissions.
 */
export class AccountAccess {
  readonly store: AccountStore;
  private readonly touched = new Map<string, number>();

  constructor(private readonly ctx: Context) {
    this.store = new AccountStore(ctx.db, ctx.env.ENCRYPTION_KEY);
  }

  /** The account connections a teammate may use: enabled, and shared with it. */
  async forBot(botId: string, kind?: AccountConnectionKind): Promise<ResolvedConnection[]> {
    const rows = await this.ctx.db
      .select({ connection: connections, account: accounts })
      .from(connections)
      .innerJoin(accounts, eq(accounts.id, connections.accountId))
      .where(
        and(
          kind ? eq(connections.kind, kind) : ne(connections.kind, "mcp"),
          eq(connections.enabled, true),
          or(isNull(connections.botIds), sql`${botId} = any(${connections.botIds})`),
        ),
      )
      .orderBy(asc(connections.createdAt));
    return rows
      .filter((row) => isAccountConnectionKind(row.connection.kind))
      .map((row) => ({
        kind: row.connection.kind as AccountConnectionKind,
        connection: row.connection,
        account: row.account,
      }));
  }

  /**
   * The connection a tool call uses. With several accounts of a kind, `account` picks one: its
   * connection id, as AGENTS.md lists it, which is always unambiguous; or an email address, a
   * workspace's name or the connection's name, but only when exactly one matches.
   */
  async resolve(
    botId: string,
    kind: AccountConnectionKind,
    account?: string,
  ): Promise<ResolvedConnection> {
    const label = integration(kind).label;
    const options = await this.forBot(botId, kind);
    if (options.length === 0)
      throw new AccountToolError(
        `You don't have ${label}. The user can connect it, and give you access, in Settings → Connections.`,
      );
    const listed = () => options.map(described).join(", ");
    const wanted = account?.trim();
    if (wanted) {
      const byId = options.find((option) => option.connection.id === wanted.toLowerCase());
      if (byId) return byId;
      const name = wanted.toLowerCase();
      const matches = options.filter(
        (option) =>
          option.account.display.toLowerCase() === name ||
          option.connection.name.toLowerCase() === name,
      );
      if (matches.length === 1) return matches[0]!;
      throw new AccountToolError(
        matches.length === 0
          ? `No ${label} account "${account}". Yours: ${listed()}.`
          : `Several ${label} accounts are called "${account}". Pass account as the id of the one you mean: ${matches.map(described).join(", ")}.`,
      );
    }
    if (options.length > 1)
      throw new AccountToolError(
        `You have several ${label} accounts. Pass account as the id of one: ${listed()}.`,
      );
    return options[0]!;
  }

  /** Throws a readable error unless the user turned the capability on and the provider granted it. */
  requireCapability(resolved: ResolvedConnection, capability: AccountCapability): void {
    const definition = integration(resolved.kind);
    const name = capabilityLabel(resolved.kind, capability);
    if (!resolved.connection.capabilities.includes(capability))
      throw new AccountToolError(
        `The user hasn't allowed "${name}" for ${definition.label}. Ask them to turn it on in Settings → Connections if you need it.`,
      );
    if (!capabilityGranted(resolved.kind, capability, resolved.account.scopes))
      throw new AccountToolError(
        `${definition.label} wasn't granted "${name}" when the user signed in. Ask them to reconnect ${definition.label} in Settings → Connections and allow it.`,
      );
  }

  /** Tokens for a provider call. A lost sign-in tells you once, and the teammate every time. */
  tokens(resolved: ResolvedConnection): TokenSource {
    const accountId = resolved.account.id;
    const wrap = async (get: () => Promise<string>) => {
      try {
        const token = await get();
        this.touch(accountId);
        return token;
      } catch (error) {
        if (error instanceof AccountUnavailableError) {
          await this.reportUnavailable(resolved, error.message);
          throw new AccountToolError(
            `${error.message} Ask the user to reconnect ${integration(resolved.kind).label} in Settings → Connections.`,
            error.message,
          );
        }
        throw error;
      }
    };
    return {
      token: () => wrap(() => this.store.accessToken(accountId)),
      refresh: () => wrap(() => this.store.refreshNow(accountId)),
    };
  }

  private touch(accountId: string): void {
    const last = this.touched.get(accountId) ?? 0;
    if (Date.now() - last < TOUCH_EVERY_MS) return;
    this.touched.set(accountId, Date.now());
    void this.store.touch(accountId).catch(() => {});
  }

  /** Tell you, once, that an account needs signing in again. */
  private async reportUnavailable(resolved: ResolvedConnection, reason: string): Promise<void> {
    const marked = await this.store.markNotified(resolved.account.id);
    await publishApp(this.ctx, { type: "connections" });
    if (!marked) return;
    await createNotification(this.ctx, {
      kind: "bot_message",
      title: `Your ${authProvider(resolved.account.provider).accountLabel} needs reconnecting`,
      body: `${reason} Teammates can't use it until you reconnect it in Settings → Connections.`,
    });
  }

  /**
   * Some providers end a grant that goes a while without a refresh (Notion, after 30 days).
   * Refreshing those idle for most of that keeps them, for a teammate that only uses the account
   * now and then.
   */
  async keepAlive(): Promise<void> {
    for (const provider of ACCOUNT_PROVIDERS) {
      const days = authProvider(provider).idleExpiryDays;
      if (!days) continue;
      const cutoff = new Date(Date.now() - days * KEEP_ALIVE_AT * DAY_MS);
      const idle = await this.ctx.db
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.provider, provider),
            eq(accounts.status, "connected"),
            lt(sql`coalesce(${accounts.lastRefreshedAt}, ${accounts.grantedAt})`, cutoff),
          ),
        );
      for (const { id } of idle) await this.refreshIdle(id, provider);
    }
  }

  private async refreshIdle(id: string, provider: string): Promise<void> {
    try {
      await this.store.refreshNow(id);
    } catch (error) {
      this.ctx.log.warn("could not keep an idle sign-in alive", {
        accountId: id,
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof AccountUnavailableError)
        await publishApp(this.ctx, { type: "connections" });
    }
  }

  /** The accounts a teammate may use, for its AGENTS.md. */
  async lines(botId: string): Promise<AccountAccessLine[]> {
    const options = await this.forBot(botId);
    return options
      .filter((option) => option.account.status === "connected")
      .map((option) => {
        const can = option.connection.capabilities
          .filter((capability) => capabilityGranted(option.kind, capability, option.account.scopes))
          .map((capability) => capabilityOption(option.kind, capability)?.can)
          .filter((entry): entry is string => Boolean(entry));
        for (const setting of integrationSettings(option.kind)) {
          const value = option.connection.settings[setting.key];
          if (value) can.push(setting.instruct(value));
        }
        return {
          kind: option.kind,
          label: option.connection.label,
          display: option.account.display,
          can,
          account: option.connection.id,
        };
      });
  }
}
