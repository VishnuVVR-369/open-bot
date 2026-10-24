"use client";

import { formatMoney } from "@open-bot/shared";
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
import { setBudget } from "@/lib/actions";
import { queryKeys, useSpending, useVault } from "@/lib/client/queries";
import type { PurchaseView } from "@/lib/types";
import { cn } from "@/lib/utils";

const STATUS: Record<PurchaseView["status"], { label: string; className: string }> = {
  pending: { label: "Waiting for you", className: "bg-waiting/12 text-waiting" },
  approved: { label: "Approved", className: "bg-live/10 text-live" },
  paid: { label: "Paid", className: "bg-done/12 text-done" },
  denied: { label: "Denied", className: "bg-muted text-muted-foreground" },
  not_paid: { label: "Didn't go through", className: "bg-muted text-muted-foreground" },
};

function dollars(cents: number | null): string {
  if (cents === null || cents === 0) return "";
  return String(cents / 100);
}

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
        onChange={(event) => onChange(event.target.value.replace(/[^\d.]/g, ""))}
        inputMode="decimal"
        disabled={disabled}
        className="pl-6 tabular-nums"
      />
    </div>
  );
}

/** What a teammate may spend from the vault's cards, and what it bought. */
export function Spending({ botId, name }: { botId: string; name: string }) {
  const { data, isLoading } = useSpending(botId);
  const { data: vault } = useVault();
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(false);
  const [budget, setBudgetValue] = useState("");
  const [autoApprove, setAutoApprove] = useState("");
  const [saving, startSaving] = useTransition();

  useEffect(() => {
    if (!data) return;
    setEnabled(data.budgetCents !== null);
    setBudgetValue(dollars(data.budgetCents));
    setAutoApprove(dollars(data.autoApproveCents));
  }, [data]);

  if (isLoading || !data) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
      </div>
    );
  }

  const cards = (vault ?? []).filter(
    (item) => item.kind === "card" && (item.botIds === null || item.botIds.includes(botId)),
  );
  const savedEnabled = data.budgetCents !== null;
  const dirty =
    enabled !== savedEnabled ||
    (enabled &&
      (budget !== dollars(data.budgetCents) || autoApprove !== dollars(data.autoApproveCents)));
  const used = data.budgetCents ? Math.min(1, data.spentCents / data.budgetCents) : 0;
  const month = new Date().toLocaleDateString("en-US", { month: "long" });

  function save() {
    startSaving(async () => {
      const result = await setBudget(botId, {
        budget: enabled ? Number(budget) : null,
        autoApprove: enabled ? Number(autoApprove || 0) : 0,
      });
      if (!result.ok) {
        toast.error("Couldn't save the budget", { description: result.error });
        return;
      }
      toast(enabled ? "Budget saved" : `${name} can't pay for things now`);
      await queryClient.invalidateQueries({ queryKey: queryKeys.spending(botId) });
    });
  }

  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-4" data-testid="budget">
        <label className="flex cursor-pointer items-start justify-between gap-4">
          <span className="flex flex-col gap-0.5">
            <span className="text-[14px] font-medium">{name} can pay for things</span>
            <span className="text-[13px] text-muted-foreground">
              With a card from the vault, up to a monthly budget.
            </span>
          </span>
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label={`${name} can pay for things`}
          />
        </label>
        {enabled && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="budget">Monthly budget</Label>
              <MoneyInput id="budget" value={budget} onChange={setBudgetValue} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="auto-approve">Approve on its own up to</Label>
              <MoneyInput id="auto-approve" value={autoApprove} onChange={setAutoApprove} />
              <span className="text-[12.5px] text-muted-foreground">
                Larger purchases ask you first. Leave empty to approve each one.
              </span>
            </div>
          </div>
        )}
        {dirty && (
          <div className="flex justify-end">
            <Button onClick={save} disabled={saving || (enabled && !Number(budget))}>
              {saving && <Loader2 className="animate-spin" />}
              Save budget
            </Button>
          </div>
        )}
        {enabled && cards.length === 0 && (
          <p className="flex items-center gap-2 rounded-lg bg-subtle px-3 py-2.5 text-[13px] text-muted-foreground">
            <CreditCard className="size-4 shrink-0" />
            <span>
              No card {name} may use yet.{" "}
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
            aria-valuenow={Math.round(used * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={cn(
                "h-full rounded-full transition-[width]",
                used >= 0.9 ? "bg-destructive" : used >= 0.7 ? "bg-waiting" : "bg-done",
              )}
              style={{ width: `${used * 100}%` }}
            />
          </div>
        </section>
      )}

      <section className="flex flex-col gap-3 border-t pt-8">
        <div className="flex flex-col gap-0.5">
          <span className="text-[14px] font-medium">Purchases</span>
          <span className="text-[13px] text-muted-foreground">
            {data.purchases.length > 0
              ? `What ${name} paid for, or asked to.`
              : `Nothing yet. When ${name} buys something, it shows here.`}
          </span>
        </div>
        {data.purchases.length > 0 && (
          <ul className="flex flex-col divide-y rounded-xl border bg-card">
            {data.purchases.map((purchase) => {
              const status = STATUS[purchase.status];
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
                          status.className,
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
                      (purchase.status === "denied" || purchase.status === "not_paid") &&
                        "text-muted-foreground line-through",
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
