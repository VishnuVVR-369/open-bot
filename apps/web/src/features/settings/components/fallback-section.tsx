"use client";

import { formatDollars } from "@open-bot/domain";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { attempt } from "@/lib/client/mutate";
import { useAppState } from "@/features/app-shell";
import { api, orpc } from "@/lib/client/rpc";
import { isComputerOnline } from "@/lib/status";
import { cn } from "@/lib/utils";
import { SectionState } from "./section-state";

/** A section's data is loading, or failed to load and can be retried. */
export function FallbackSection() {
  const queryClient = useQueryClient();
  const [pending, startTransition] = useTransition();
  const [key, setKey] = useState("");
  const [cap, setCap] = useState<string | null>(null);
  const access = useQuery(orpc.settings.modelAccess.queryOptions());
  const { data: state } = useAppState();
  // Nothing runs while the computer is offline, so the plan is what teammates use, not what
  // they're running on.
  const offline = Boolean(state && !isComputerOnline(state));
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: orpc.settings.modelAccess.key() });
  const data = access.data;
  if (!data) return <SectionState error={access.error} onRetry={() => void access.refetch()} />;
  const capDollars = data.capMicros / 1_000_000;
  const capChanged = cap !== null && cap !== "" && Number(cap) !== capDollars;
  const used = data.capMicros > 0 ? Math.min(100, (data.spendMicros / data.capMicros) * 100) : 100;

  return (
    <>
      <div
        className={cn(
          "flex items-start gap-3 rounded-xl px-4 py-3.5",
          data.planLimitedUntil && !offline
            ? "border border-attention/40 bg-attention/[0.07]"
            : "border bg-card",
        )}
        data-testid="fallback-status"
      >
        <span
          className={cn(
            "mt-1.5 size-2.5 shrink-0 rounded-full",
            offline ? "bg-idle" : data.planLimitedUntil ? "bg-attention" : "bg-done",
          )}
        />
        <div className="flex flex-col gap-0.5">
          <span className="text-[14px] font-medium">
            {offline
              ? data.planLimitedUntil && data.keyHint
                ? "Set to use your API key"
                : "Set to use your ChatGPT plan"
              : data.planLimitedUntil
                ? data.keyHint
                  ? "Running on your API key"
                  : "Stopped: your plan's limit is reached"
                : "Running on your ChatGPT plan"}
          </span>
          <span className="text-[13px] text-muted-foreground">
            {offline
              ? data.keyHint
                ? "Nothing runs while the computer is offline. Once it's back, teammates use your plan, then your API key if the plan's limit is reached."
                : "Nothing runs while the computer is offline. Once it's back, teammates use your plan."
              : data.planLimitedUntil
                ? `Your plan's limit resets ${formatDistanceToNowStrict(new Date(data.planLimitedUntil), { addSuffix: true })}. Then teammates switch back to it on their own.`
                : data.keyHint
                  ? "If the plan's limit is reached, teammates continue on your API key until it resets."
                  : "Add an API key so teammates keep working when the plan's limit is reached."}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-xl border bg-card px-4 py-3.5">
        <span className="text-[14px] font-medium">OpenAI API key</span>
        {data.keyHint ? (
          <div className="flex items-center gap-3">
            <code className="rounded bg-subtle px-2 py-1 font-mono text-[13px]">
              {data.keyHint}
            </code>
            <span className="text-[13px] text-muted-foreground">Stored encrypted.</span>
            <span className="flex-1" />
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm" disabled={pending}>
                  Remove
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove your API key?</AlertDialogTitle>
                  <AlertDialogDescription>
                    When your plan's limit is reached, teammates stop until it resets instead of
                    continuing on the key. You can add a key again any time.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={() =>
                      startTransition(async () => {
                        const result = await attempt(api.settings.removeApiKey());
                        if (!result.ok) toast.error(result.error);
                        else toast("API key removed");
                        await refresh();
                      })
                    }
                  >
                    Remove key
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        ) : (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              startTransition(async () => {
                const result = await attempt(api.settings.saveApiKey({ apiKey: key }));
                if (!result.ok) {
                  toast.error(result.error);
                  return;
                }
                setKey("");
                toast("API key saved");
                await refresh();
              });
            }}
          >
            <Input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="sk-…"
              aria-label="OpenAI API key"
              className="font-mono"
            />
            <Button type="submit" disabled={pending || !key.trim()}>
              Save key
            </Button>
          </form>
        )}
      </div>

      <div className="flex flex-col gap-3 rounded-xl border bg-card px-4 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-[14px] font-medium">Monthly cap</span>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              startTransition(async () => {
                const result = await attempt(
                  api.settings.setMonthlyCap({ dollars: Number(cap ?? capDollars) }),
                );
                if (!result.ok) toast.error(result.error);
                else toast("Cap saved");
                setCap(null);
                await refresh();
              });
            }}
          >
            <span className="relative">
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-[14px] text-muted-foreground"
              >
                $
              </span>
              <Input
                inputMode="decimal"
                value={cap ?? String(capDollars)}
                onChange={(event) => setCap(event.target.value.replace(/[^0-9.]/g, ""))}
                className="w-28 pl-6 tabular-nums"
                aria-label="Monthly cap in dollars"
              />
            </span>
            <Button
              type="submit"
              variant={capChanged ? "default" : "outline"}
              size="sm"
              disabled={pending || !capChanged}
            >
              Save
            </Button>
          </form>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between text-[13px]">
            <span className="text-muted-foreground">Spent on the API this month</span>
            <span className="tabular-nums">
              {formatDollars(data.spendMicros)} of {formatDollars(data.capMicros)}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-foreground/8">
            <div
              className={cn(
                "h-full rounded-full",
                used >= 100 ? "bg-destructive" : used > 80 ? "bg-attention" : "bg-foreground/45",
              )}
              style={{ width: `${used}%` }}
            />
          </div>
          <span className="text-[12.5px] text-muted-foreground">
            At list prices: $2 per million input tokens, $0.10 cached, $10 output. At the cap,
            teammates stop until the plan resets.
          </span>
        </div>
      </div>
    </>
  );
}
