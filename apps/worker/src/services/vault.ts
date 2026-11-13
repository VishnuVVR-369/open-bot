import { bots, purchases, vaultItems, type Queryable } from "@open-bot/db";
import {
  type ApprovalDecision,
  budgetDecision,
  cardHint,
  type CardSecret,
  FIELD_LABEL,
  formatMoney,
  invalidCard,
  type LoginSecret,
  monthStart,
  normalizeDomain,
  normalizeExpiry,
  PURCHASE_WINDOW_MS,
  SPENDING_PURCHASE_STATUSES,
  toCents,
  VAULT_FIELDS,
  type VaultField,
  type VaultKind,
} from "@open-bot/domain";
import { decryptSecret, encryptSecret } from "@open-bot/domain/server";
import { and, desc, eq, gte, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { publishApp, type Context } from "../context";
import type { RunSession } from "../runs/session";
import type { ApprovalService } from "../features/approvals";
import type { VaultItemInput } from "@open-bot/api";
import { WorkerError } from "../core/errors";

type Item = typeof vaultItems.$inferSelect;

export class VaultError extends WorkerError {
  constructor(message: string) {
    super(400, message);
  }
}

/** A change to the vault you asked for that can't be made; the message says why. */
export class VaultItemError extends WorkerError {}

/** A login's or card's secret, and the hint the vault shows of it, or why it can't be saved. */
function vaultSecret(
  kind: VaultKind,
  fields: Record<string, string>,
  domainInput: string,
): { secret: LoginSecret | CardSecret; hint: string; domain: string | null } {
  if (kind === "login") {
    const domain = normalizeDomain(domainInput);
    if (!domain) throw new VaultItemError(400, "Give the site it's for, like github.com.");
    const username = (fields.username ?? "").trim();
    const password = fields.password ?? "";
    if (!username) throw new VaultItemError(400, "Add the username or email.");
    if (!password) throw new VaultItemError(400, "Add the password.");
    return { secret: { username, password }, hint: username, domain };
  }
  const card: CardSecret = {
    number: (fields.number ?? "").replace(/[\s-]/g, ""),
    expiry: normalizeExpiry(fields.expiry ?? "") ?? fields.expiry ?? "",
    cvc: (fields.cvc ?? "").trim(),
    name: (fields.name ?? "").trim(),
    zip: (fields.zip ?? "").trim(),
  };
  const problem = invalidCard(card);
  if (problem) throw new VaultItemError(400, problem);
  return { secret: card, hint: cardHint(card.number), domain: null };
}

/** Tie a purchase to the approval that asks you about it. */
export async function askAboutPurchase(
  db: Queryable,
  purchaseId: string,
  approvalId: string,
): Promise<void> {
  await db.update(purchases).set({ approvalId }).where(eq(purchases.id, purchaseId));
}

/**
 * Your decision on a purchase's approval: approved opens its card to the teammate for a while.
 * Returns the purchase, when one was still waiting on it.
 */
export async function decidePurchase(
  db: Queryable,
  approvalId: string,
  decision: ApprovalDecision,
): Promise<typeof purchases.$inferSelect | undefined> {
  const [decided] = await db
    .update(purchases)
    .set({
      status: decision,
      fillableUntil: decision === "approved" ? new Date(Date.now() + PURCHASE_WINDOW_MS) : null,
    })
    .where(and(eq(purchases.approvalId, approvalId), eq(purchases.status, "pending")))
    .returning();
  return decided;
}

/**
 * The vault from a teammate's side: it sees what it may use, fills logins and cards on its screen
 * without reading them, and pays only within its monthly budget.
 */
export class VaultService {
  constructor(
    private readonly ctx: Context,
    private readonly approvals: ApprovalService,
  ) {}

  /** Save a login or card you entered. Secrets are encrypted here and never sent back. */
  async saveItem(input: VaultItemInput): Promise<{ id: string }> {
    const saved = await this.ctx.db.transaction(async (tx) => {
      // Locked, so two edits at once each keep the other's fields instead of the last one winning.
      const [existing] = input.id
        ? await tx.select().from(vaultItems).where(eq(vaultItems.id, input.id)).for("update")
        : [];
      if (input.id && !existing)
        throw new VaultItemError(404, "That item is no longer in the vault.");
      if (existing && existing.kind !== input.kind)
        throw new VaultItemError(400, "An item can't change its kind.");
      const fields: Record<string, string> = existing
        ? JSON.parse(decryptSecret(existing.encrypted, this.ctx.env.ENCRYPTION_KEY))
        : {};
      // Fields left empty keep what's saved, except the username: the form shows it, so an empty
      // one was cleared.
      for (const [field, value] of Object.entries(input.secret))
        if (value.trim() || field === "username") fields[field] = value;
      const { secret, hint, domain } = vaultSecret(input.kind, fields, input.domain);
      const values = {
        kind: input.kind,
        name: input.name,
        domain,
        hint,
        botIds: input.teammateIds,
        encrypted: encryptSecret(JSON.stringify(secret), this.ctx.env.ENCRYPTION_KEY),
      };
      const [row] = existing
        ? await tx
            .update(vaultItems)
            .set(values)
            .where(eq(vaultItems.id, existing.id))
            .returning({ id: vaultItems.id })
        : await tx.insert(vaultItems).values(values).returning({ id: vaultItems.id });
      return row!;
    });
    await publishApp(this.ctx, { type: "vault" });
    return saved;
  }

  async removeItem(itemId: string): Promise<void> {
    await this.ctx.db.delete(vaultItems).where(eq(vaultItems.id, itemId));
    await publishApp(this.ctx, { type: "vault" });
  }

  /** The items a teammate may use. */
  private async itemsFor(botId: string): Promise<Item[]> {
    return this.ctx.db
      .select()
      .from(vaultItems)
      .where(or(isNull(vaultItems.botIds), sql`${botId} = any(${vaultItems.botIds})`))
      .orderBy(vaultItems.kind, vaultItems.name);
  }

  private async item(botId: string, id: string): Promise<Item> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new VaultError("No vault item with that id.");
    const items = await this.itemsFor(botId);
    const item = items.find((entry) => entry.id === id);
    if (!item) throw new VaultError("No vault item with that id that you may use. See vault_list.");
    return item;
  }

  async spentThisMonth(botId: string): Promise<number> {
    const [row] = await this.ctx.db
      .select({ total: sql<number>`coalesce(sum(${purchases.amountCents}), 0)::int` })
      .from(purchases)
      .where(
        and(
          eq(purchases.botId, botId),
          inArray(purchases.status, [...SPENDING_PURCHASE_STATUSES]),
          gte(purchases.createdAt, monthStart()),
        ),
      );
    return row?.total ?? 0;
  }

  /** What the teammate reads from vault_list. No secrets, only what tells items apart. */
  async describe(botId: string): Promise<string> {
    const items = await this.itemsFor(botId);
    const [bot] = await this.ctx.db.select().from(bots).where(eq(bots.id, botId));
    const lines: string[] = [];
    const logins = items.filter((item) => item.kind === "login");
    const cards = items.filter((item) => item.kind === "card");
    lines.push(
      logins.length
        ? `Logins (fields: ${VAULT_FIELDS.login.join(", ")}):\n${logins
            .map((item) => `- ${item.name} for ${item.domain} as ${item.hint} (id ${item.id})`)
            .join("\n")}`
        : "Logins: none saved for you.",
    );
    lines.push(
      cards.length
        ? `Cards (fields: ${VAULT_FIELDS.card.join(", ")}; start_purchase first):\n${cards
            .map((item) => `- ${item.name}, ${item.hint} (id ${item.id})`)
            .join("\n")}`
        : "Cards: none saved for you.",
    );
    if (bot?.monthlyBudgetCents) {
      const spent = await this.spentThisMonth(botId);
      lines.push(
        `Budget: ${formatMoney(Math.max(0, bot.monthlyBudgetCents - spent))} left of ${formatMoney(bot.monthlyBudgetCents)} this month. Purchases up to ${formatMoney(bot.autoApproveCents)} go ahead; larger ones ask the user.`,
      );
    } else {
      lines.push("Budget: none, so you can't pay for things.");
    }
    return lines.join("\n\n");
  }

  /** Type one field of an item on the teammate's screen, into whatever has focus. */
  async fill(
    session: RunSession,
    input: { itemId: string; field: string },
  ): Promise<{ label: string; site: string | null }> {
    const item = await this.item(session.bot.id, input.itemId);
    const fields: readonly string[] = VAULT_FIELDS[item.kind];
    if (!fields.includes(input.field))
      throw new VaultError(`A ${item.kind} has these fields: ${fields.join(", ")}.`);
    const field = input.field as VaultField;
    if (item.kind === "card") {
      const [purchase] = await this.ctx.db
        .select({ id: purchases.id })
        .from(purchases)
        .where(
          and(
            eq(purchases.botId, session.bot.id),
            eq(purchases.cardId, item.id),
            eq(purchases.status, "approved"),
            gt(purchases.fillableUntil, new Date()),
          ),
        )
        .limit(1);
      if (!purchase)
        throw new VaultError(
          "There's no approved purchase for this card right now. Call start_purchase with the amount and the shop first.",
        );
    }
    const secret = JSON.parse(decryptSecret(item.encrypted, this.ctx.env.ENCRYPTION_KEY)) as
      LoginSecret | CardSecret;
    const value = String((secret as unknown as Record<string, string>)[field] ?? "");
    if (!value) throw new VaultError(`The ${FIELD_LABEL[field]} isn't saved for ${item.name}.`);
    const site = item.kind === "login" ? normalizeDomain(item.domain ?? "") : null;
    if (item.kind === "login" && !site)
      throw new VaultError(`${item.name} has no site saved, so it can't be filled.`);
    const result = await this.ctx.computer.fill({ run: session.identity, secret: value, site });
    if (!result.ok)
      throw new VaultError(
        result.code === "user_has_control" ? "You took over this screen" : result.message,
      );
    await this.ctx.db
      .update(vaultItems)
      .set({ lastUsedAt: new Date() })
      .where(eq(vaultItems.id, item.id));
    await publishApp(this.ctx, { type: "vault" });
    return { label: `${item.name} ${FIELD_LABEL[field]}`, site };
  }

  /**
   * Ask to pay with a card: within the budget, small amounts go ahead and larger ones ask you.
   * Returns the purchase and whether the card may be filled now.
   */
  async startPurchase(
    session: RunSession,
    input: {
      cardId: string;
      amount: number | string;
      merchant: string;
      description: string;
      itemId: string;
    },
  ): Promise<{
    id: string;
    status: "approved" | "denied" | "pending";
    /** Whether it asked you, rather than going ahead within the auto-approve amount. */
    asked: boolean;
    message: string;
  }> {
    const card = await this.item(session.bot.id, input.cardId);
    if (card.kind !== "card") throw new VaultError("That's a login, not a card.");
    const amountCents = toCents(input.amount);
    if (amountCents === null) throw new VaultError("Give the amount in dollars, like 42.50.");
    const merchant = input.merchant.trim().slice(0, 120);
    const description = input.description.trim().slice(0, 500);
    if (!merchant || !description) throw new VaultError("Say where you're buying, and what.");

    const [bot] = await this.ctx.db.select().from(bots).where(eq(bots.id, session.bot.id));
    const decision = budgetDecision({
      budgetCents: bot?.monthlyBudgetCents ?? null,
      autoApproveCents: bot?.autoApproveCents ?? 0,
      spentCents: await this.spentThisMonth(session.bot.id),
      amountCents,
    });
    if (!decision.ok) throw new VaultError(decision.reason);

    const [purchase] = await this.ctx.db
      .insert(purchases)
      .values({
        botId: session.bot.id,
        cardId: card.id,
        runId: session.run.id,
        chatId: session.chat.id,
        amountCents,
        merchant,
        description,
        status: decision.needsApproval ? "pending" : "approved",
        fillableUntil: decision.needsApproval ? null : new Date(Date.now() + PURCHASE_WINDOW_MS),
      })
      .returning();
    await publishApp(this.ctx, { type: "purchases" });
    const title = `Pay ${formatMoney(amountCents)} at ${merchant}`;
    if (!decision.needsApproval)
      return {
        id: purchase!.id,
        status: "approved",
        asked: false,
        message: `Approved within your budget (${formatMoney(decision.leftCents)} left after it). Fill the card with vault_fill in the next 30 minutes, then call finish_purchase.`,
      };

    const answer = await this.approvals.requestPurchase(session, {
      purchaseId: purchase!.id,
      title,
      detail: `${description}\n\nCard: ${card.name} (${card.hint}). ${formatMoney(decision.leftCents)} of the monthly budget is left after it.`,
      itemId: input.itemId,
    });
    if (answer === "approved")
      return {
        id: purchase!.id,
        status: "approved",
        asked: true,
        message:
          "The user approved it. Fill the card with vault_fill in the next 30 minutes, then call finish_purchase.",
      };
    if (answer === "denied")
      return {
        id: purchase!.id,
        status: "denied",
        asked: true,
        message: "The user denied it. Don't buy it; ask what they'd like instead.",
      };
    return {
      id: purchase!.id,
      status: "pending",
      asked: true,
      message:
        "Still waiting for the user to approve it. End your turn and say so; you'll get a message with their decision.",
    };
  }

  /** The teammate says whether checkout went through. Called off purchases don't count. */
  async finishPurchase(
    session: RunSession,
    input: { purchaseId: string; paid: boolean; note: string },
  ): Promise<typeof purchases.$inferSelect> {
    if (!/^[0-9a-f-]{36}$/i.test(input.purchaseId))
      throw new VaultError("No purchase with that id.");
    const [row] = await this.ctx.db
      .update(purchases)
      .set({
        status: input.paid ? "paid" : "not_paid",
        note: input.note.trim().slice(0, 500) || null,
        fillableUntil: null,
      })
      .where(
        and(
          eq(purchases.id, input.purchaseId),
          eq(purchases.botId, session.bot.id),
          inArray(purchases.status, ["approved", "pending"]),
        ),
      )
      .returning();
    if (!row) throw new VaultError("No open purchase of yours with that id.");
    await publishApp(this.ctx, { type: "purchases" });
    return row;
  }

  /** The teammate's recent purchases, newest first. */
  recent(botId: string) {
    return this.ctx.db
      .select()
      .from(purchases)
      .where(eq(purchases.botId, botId))
      .orderBy(desc(purchases.createdAt))
      .limit(20);
  }
}
