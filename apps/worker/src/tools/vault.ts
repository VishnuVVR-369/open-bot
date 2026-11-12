// Vault tools: fill logins and cards on the screen, and purchases.
import { formatMoney } from "@open-bot/domain";
import { z } from "zod";
import type { RunSession } from "../runs/session";
import { VaultError } from "../services/vault";
import {
  defineTool,
  text,
  type ToolDefinition,
  type ToolDeps,
  toolItem,
  type ToolResponse,
} from "./define";

export const VAULT_TOOLS: ToolDefinition[] = [
  defineTool({
    name: "vault_list",
    description:
      "List the logins and payment cards the user saved in the vault for you, and your spending budget. You never see the secrets themselves: vault_fill types them for you.",
    input: z.object({}),
    helpers: "allowed",
    handle: async ({ session }, deps) => text(await deps.vault.describe(session.bot.id)),
  }),
  defineTool({
    name: "vault_fill",
    description:
      "Type one field of a saved login or card into the field that has keyboard focus on your screen: click the field first. You never see the value. A login only fills on its own site; a card needs an approved purchase (start_purchase). Take a screenshot afterwards to check.",
    input: z.object({
      item_id: z.string().describe("The id from vault_list."),
      field: z
        .enum(["username", "password", "number", "expiry", "cvc", "name", "zip"])
        .describe("Logins: username or password. Cards: number, expiry (MM/YY), cvc, name, zip."),
    }),
    helpers: "allowed",
    handle: ({ session, callId, args }, deps) => vaultFill(deps, session, callId, args),
  }),
  defineTool({
    name: "start_purchase",
    description:
      "Before paying with a vault card, say what you'll pay. It must fit your monthly budget; small amounts go ahead and larger ones ask the user (it waits up to 10 minutes). Once approved, you can fill the card for 30 minutes. Give the exact total at checkout, including tax and shipping.",
    input: z.object({
      card_id: z.string().describe("The card's id from vault_list."),
      amount: z.number().gt(0).describe("The total in US dollars."),
      merchant: z.string().min(1).max(120).describe("The shop or site."),
      description: z
        .string()
        .min(1)
        .max(500)
        .describe("What you're buying, for the user to judge quickly."),
    }),
    helpers: "forbidden",
    handle: ({ session, callId, args }, deps) => startPurchase(deps, session, callId, args),
  }),
  defineTool({
    name: "finish_purchase",
    description:
      "Say whether a purchase went through, after checkout. One that didn't stops counting against your budget.",
    input: z.object({
      purchase_id: z.string(),
      paid: z.boolean().describe("True if the payment went through."),
      note: z
        .string()
        .max(500)
        .describe("The order number, or why it didn't go through.")
        .optional(),
    }),
    helpers: "allowed",
    handle: ({ session, callId, args }, deps) => finishPurchase(deps, session, callId, args),
  }),
];

async function vaultFill(
  deps: ToolDeps,
  session: RunSession,
  callId: string,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const item = toolItem(callId, "vault_fill", "Filled from the vault", args, session.now());
  session.putItem(item);
  try {
    const { label, site } = await deps.vault.fill(session, {
      itemId: String(args.item_id ?? ""),
      field: String(args.field ?? ""),
    });
    session.putItem({
      ...item,
      label: `Filled the ${label}`,
      status: "completed",
      completedAt: session.now(),
      ...(site ? { result: `On ${site}` } : {}),
    });
    return text("Filled. Take a screenshot to check it went into the right field.");
  } catch (error) {
    if (!(error instanceof VaultError)) throw error;
    session.putItem({
      ...item,
      label: "Couldn't fill from the vault",
      status: "failed",
      completedAt: session.now(),
      error: error.message,
    });
    return text(error.message, false);
  }
}

async function startPurchase(
  deps: ToolDeps,
  session: RunSession,
  callId: string,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const startedAt = session.now();
  try {
    const purchase = await deps.vault.startPurchase(session, {
      cardId: String(args.card_id ?? ""),
      amount: typeof args.amount === "number" ? args.amount : String(args.amount ?? ""),
      merchant: String(args.merchant ?? ""),
      description: String(args.description ?? ""),
      itemId: callId,
    });
    // Larger purchases show as the approval; ones within the auto-approve amount show here.
    if (!purchase.asked) {
      session.putItem({
        ...toolItem(
          callId,
          "start_purchase",
          `Paying ${formatMoney(Math.round(Number(args.amount) * 100))} at ${String(args.merchant)}`,
          args,
          startedAt,
        ),
        status: "completed",
        completedAt: session.now(),
        result: "Within its budget",
      });
    }
    return text(`Purchase ${purchase.id}: ${purchase.message}`, purchase.status !== "denied");
  } catch (error) {
    if (!(error instanceof VaultError)) throw error;
    session.putItem({
      ...toolItem(callId, "start_purchase", "Couldn't start a purchase", args, startedAt),
      status: "failed",
      completedAt: session.now(),
      error: error.message,
    });
    return text(error.message, false);
  }
}

async function finishPurchase(
  deps: ToolDeps,
  session: RunSession,
  callId: string,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const startedAt = session.now();
  try {
    const purchase = await deps.vault.finishPurchase(session, {
      purchaseId: String(args.purchase_id ?? ""),
      paid: args.paid === true,
      note: typeof args.note === "string" ? args.note : "",
    });
    const amount = formatMoney(purchase.amountCents);
    session.putItem({
      ...toolItem(
        callId,
        "finish_purchase",
        purchase.status === "paid"
          ? `Paid ${amount} at ${purchase.merchant}`
          : `Didn't pay ${amount} at ${purchase.merchant}`,
        args,
        startedAt,
      ),
      status: "completed",
      completedAt: session.now(),
      ...(purchase.note ? { result: purchase.note } : {}),
    });
    return text(
      purchase.status === "paid"
        ? "Recorded as paid."
        : "Recorded as not paid; it no longer counts against your budget.",
    );
  } catch (error) {
    if (error instanceof VaultError) return text(error.message, false);
    throw error;
  }
}
