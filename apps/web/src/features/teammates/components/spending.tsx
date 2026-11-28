"use client";

import {
  budgetConflictText,
  budgetCopy,
  budgetDraft,
  budgetDraftChanged,
  budgetInput,
  budgetSaved,
  budgetUse,
  editBudget,
  followBudget,
  formatMoney,
  mayUse,
  moneyInput,
  PURCHASE_STATUS,
  purchaseCalledOff,
  settleBudgetConflict,
  spendingMonth,
  type BudgetDraft,
  type BudgetForm,
} from "@open-bot/domain";
import { useQueryClient } from "@tanstack/react-query";
import { CreditCard, Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { TimeAgo } from "@/components/time-ago";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { attempt } from "@/lib/client/mutate";
import { useVault } from "@/features/vault";
import { useSpending } from "../hooks";
import { api, orpc } from "@/lib/client/rpc";
import { cn } from "@/lib/utils";

const TONE_CLASS = {
  attention: "bg-attention/12 text-attention-ink",
  done: "bg-done/10 text-done",
  muted: "bg-muted text-muted-foreground",
} as const;

/** A dollar amount input with a $ in front. */
function MoneyInput({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[14px] text-muted-foreground">
        $
      </span>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(moneyInput(event.target.value))}
        inputMode="decimal"
        disabled={disabled}
        className="pl-6 tabular-nums"
      />
    </div>
  );
}

/** What a teammate may spend from the vault's cards, and what it bought. */
export function Spending({ teammateId, name }: { teammateId: string; name: string }) {
  const { data, isLoading } = useSpending(teammateId);
  const { data: vault } = useVault();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<BudgetDraft | null>(null);
  const [saving, startSaving] = useTransition();
  const copy = budgetCopy(name);

  // The saved budget, changed here or elsewhere: what you haven't touched follows it, and a change
  // to what you changed too waits for you to take it or keep yours. A save names the budget your
  // changes started from, so one saved elsewhere since is refused, never overwritten. A purchase
  // the teammate makes meanwhile changes only what's spent, so it leaves the form alone.
  const budgetCents = data?.budgetCents;
  const autoApproveCents = data?.autoApproveCents;
  useEffect(() => {
    if (budgetCents === undefined || autoApproveCents === undefined || saving) return;
    const fresh = { budgetCents, autoApproveCents };
    setDraft((current) => (current ? followBudget(current, fresh) : budgetDraft(fresh)));
  }, [budgetCents, autoApproveCents, saving]);

  if (isLoading || !data || !draft) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
      </div>
    );
  }

  const { form, theirs } = draft;
  const { enabled, budget, autoApprove } = form;
  const set = (patch: Partial<BudgetForm>) =>
    setDraft((current) => current && editBudget(current, patch));
  const settle = (keep: "theirs" | "mine") =>
    setDraft((current) => current && settleBudgetConflict(current, keep));
  const cards = (vault ?? []).filter((item) => item.kind === "card" && mayUse(item, teammateId));
  const dirty = budgetDraftChanged(draft) || theirs !== null;
  const use = budgetUse(data);
  const month = spendingMonth();

  function save() {
    if (!draft || draft.theirs) return;
    const expected = draft.base;
    startSaving(async () => {
      const result = await attempt(
        api.teammates.setBudget({ teammateId, ...budgetInput(form), expected }),
      );
      if (!result.ok) {
        toast.error("Couldn't save the budget", { description: result.error });
        await queryClient.invalidateQueries({
          queryKey: orpc.teammates.spending.key({ input: { teammateId } }),
        });
        return;
      }
      toast(enabled ? copy.saved : copy.off);
      setDraft((current) => current && budgetSaved(current));
      await queryClient.invalidateQueries({
        queryKey: orpc.teammates.spending.key({ input: { teammateId } }),
      });
    });
  }

  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-4" data-testid="budget">
        <label className="flex cursor-pointer items-start justify-between gap-4">
          <span className="flex flex-col gap-0.5">
            <span className="text-[14px] font-medium">{copy.canPay}</span>
            <span className="text-[13px] text-muted-foreground">{copy.canPayHint}</span>
          </span>
          <Switch
            checked={enabled}
            onCheckedChange={(value) => set({ enabled: value })}
            aria-label={copy.canPay}
          />
        </label>
        {enabled && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="budget">{copy.monthly}</Label>
              <MoneyInput id="budget" value={budget} onChange={(value) => set({ budget: value })} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="auto-approve">{copy.autoApprove}</Label>
              <MoneyInput
                id="auto-approve"
                value={autoApprove}
                onChange={(value) => set({ autoApprove: value })}
              />
              <span className="text-[12.5px] text-muted-foreground">{copy.autoApproveHint}</span>
            </div>
          </div>
        )}
        {theirs && (
          <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-attention/35 bg-attention/[0.04] px-3 py-2.5"
            data-testid="budget-conflict"
          >
            <span className="text-[13px] text-attention-ink">
              {budgetConflictText(theirs, name)}
            </span>
            <span className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => settle("theirs")}>
                Use theirs
              </Button>
              <Button size="sm" variant="outline" onClick={() => settle("mine")}>
                Keep mine
              </Button>
            </span>
          </div>
        )}
        {dirty && (
          <div className="flex justify-end">
            <Button
              onClick={save}
              disabled={saving || theirs !== null || (enabled && !Number(budget))}
            >
              {saving && <Loader2 className="animate-spin" />}
              Save budget
            </Button>
          </div>
        )}
        {enabled && cards.length === 0 && (
          <p className="flex items-center gap-2 rounded-lg bg-subtle px-3 py-2.5 text-[13px] text-muted-foreground">
            <CreditCard className="size-4 shrink-0" />
            <span>
              {copy.noCard}{" "}
              <Link href="/vault" className="text-foreground underline underline-offset-2">
                Add one in the vault
              </Link>
              .
            </span>
          </p>
        )}
      </section>

      {data.budgetCents !== null && (
        <section className="flex flex-col gap-2.5 border-t pt-8" data-testid="spent">
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-[14px] font-medium">Spent in {month}</span>
            <span className="text-[14px]">
              {formatMoney(data.spentCents)}
              <span className="text-muted-foreground"> of {formatMoney(data.budgetCents)}</span>
            </span>
          </div>
          <div
            className="h-2 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label={`Spent in ${month}`}
            aria-valuenow={Math.round(use.share * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={cn(
                "h-full rounded-full transition-[width]",
                use.tone === "destructive"
                  ? "bg-destructive"
                  : use.tone === "attention"
                    ? "bg-attention"
                    : "bg-done",
              )}
              style={{ width: `${use.share * 100}%` }}
            />
          </div>
        </section>
      )}

      <section className="flex flex-col gap-3 border-t pt-8">
        <div className="flex flex-col gap-0.5">
          <span className="text-[14px] font-medium">Purchases</span>
          <span className="text-[13px] text-muted-foreground">
            {data.purchases.length > 0 ? copy.purchases : copy.noPurchases}
          </span>
        </div>
        {data.purchases.length > 0 && (
          <ul className="flex flex-col divide-y divide-border/70 rounded-xl border bg-card">
            {data.purchases.map((purchase) => {
              const status = PURCHASE_STATUS[purchase.status];
              return (
                <li
                  key={purchase.id}
                  className="flex items-start gap-3 px-4 py-3"
                  data-testid="purchase"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2 text-[14px] font-medium">
                      {purchase.merchant}
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[11.5px] font-medium",
                          TONE_CLASS[status.tone],
                        )}
                      >
                        {status.label}
                      </span>
                    </span>
                    <span className="text-[13px] text-muted-foreground">
                      {purchase.description}
                    </span>
                    <span className="flex flex-wrap gap-x-3 text-[12.5px] text-muted-foreground">
                      <TimeAgo date={purchase.createdAt} />
                      {purchase.card && <span>{purchase.card}</span>}
                      {purchase.note && <span>{purchase.note}</span>}
                      {purchase.chatId && (
                        <Link
                          href={`/chats/${purchase.chatId}${purchase.runId ? `#run-${purchase.runId}` : ""}`}
                          className="underline-offset-2 hover:underline"
                        >
                          Open chat
                        </Link>
                      )}
                    </span>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 text-[14px] font-medium",
                      purchaseCalledOff(purchase.status) && "text-muted-foreground line-through",
                    )}
                  >
                    {formatMoney(purchase.amountCents)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
