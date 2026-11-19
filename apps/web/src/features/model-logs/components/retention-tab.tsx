"use client";

import { MODEL_LOG_RETENTION_CHOICES, retentionLabel } from "@open-bot/domain";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
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
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { attempt } from "@/lib/client/mutate";
import { api, orpc } from "@/lib/client/rpc";
import { useModelLogRetention } from "../hooks";
import { LoadError } from "./controls";

const FOREVER = "forever";

const day = (iso: string) => format(new Date(iso), "MMM d, yyyy");

function List({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-[13.5px] font-medium">{title}</h3>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] text-muted-foreground marker:text-faint">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/** How long model logs keep what was sent and what came back, in plain words. */
export function RetentionTab() {
  const retention = useModelLogRetention();
  const queryClient = useQueryClient();
  const [pending, startTransition] = useTransition();
  /** A shorter window, waiting for the owner to confirm that older bodies go for good. */
  const [confirm, setConfirm] = useState<number | null>(null);
  const data = retention.data;
  if (!data) {
    if (retention.error)
      return <LoadError error={retention.error} onRetry={() => void retention.refetch()} />;
    return <Skeleton className="h-48 w-full rounded-xl" />;
  }
  const save = (days: number | null) =>
    startTransition(async () => {
      const result = await attempt(api.modelLogs.setRetention({ days }));
      if (!result.ok) toast.error(result.error);
      else toast("Retention saved", { description: retentionLabel(days) });
      await queryClient.invalidateQueries({ queryKey: orpc.modelLogs.retention.key() });
    });
  const choose = (value: string) => {
    const days = value === FOREVER ? null : Number(value);
    if (days === data.days) return;
    // Keeping less removes bodies for good, so ask first; keeping more never removes anything.
    if (days !== null && (data.days === null || days < data.days)) setConfirm(days);
    else save(days);
  };
  return (
    <div className="flex flex-col gap-5" data-testid="model-logs-retention">
      <section className="flex flex-col gap-4 rounded-xl border bg-card px-4 py-4">
        <div className="flex flex-col gap-1">
          <h3 className="text-[14px] font-semibold">Keep what was sent and what came back</h3>
          <p className="max-w-[62ch] text-[13px] text-muted-foreground">
            Model logs can get large. Choose how long they keep the full text of each request.
            Everything else stays, so the Runs, Tools and Usage tabs keep their numbers.
          </p>
        </div>
        <Select
          value={data.days === null ? FOREVER : String(data.days)}
          onValueChange={choose}
          disabled={pending}
        >
          <SelectTrigger
            className="w-60"
            aria-label="Keep bodies for"
            data-testid="retention-select"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={FOREVER}>Forever (default)</SelectItem>
            {MODEL_LOG_RETENTION_CHOICES.map((days) => (
              <SelectItem key={days} value={String(days)}>
                {retentionLabel(days)}
              </SelectItem>
            ))}
            {data.days !== null &&
              !(MODEL_LOG_RETENTION_CHOICES as readonly number[]).includes(data.days) && (
                <SelectItem value={String(data.days)}>{retentionLabel(data.days)}</SelectItem>
              )}
          </SelectContent>
        </Select>
        <p className="text-[12.5px] text-muted-foreground" data-testid="retention-status">
          {data.oldestKept
            ? `The oldest request still has its bodies from ${day(data.oldestKept)}.`
            : "No request has its bodies kept right now."}
          {data.lastExpiredAt ? ` Bodies last expired on ${day(data.lastExpiredAt)}.` : ""}
        </p>
      </section>
      <div className="grid gap-5 sm:grid-cols-2">
        <List
          title="What expires"
          items={[
            "What each request sent: messages, instructions and tool definitions",
            "What came back: the reply text, reasoning summaries and the raw response",
            "Tool call arguments and what each tool returned",
            "The full text of Codex's messages about the run",
          ]}
        />
        <List
          title="What stays"
          items={[
            "When each request ran, for which teammate, run and chat",
            "Model, tokens, cost, status and error messages",
            "Tool names, and whether each call worked or failed",
            "Links between runs, requests and tool calls",
          ]}
        />
      </div>
      <p className="max-w-[70ch] text-[12.5px] text-muted-foreground">
        The worker checks once a day, and again right after you change this. A run whose bodies
        expired still opens; it says when they expired. Exports only hold what is still kept.
      </p>
      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Keep bodies for {confirm !== null ? retentionLabel(confirm).toLowerCase() : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              What was sent and what came back in requests older than that is removed for good,
              starting now. Their numbers and tool outcomes stay.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (confirm !== null) save(confirm);
                setConfirm(null);
              }}
              data-testid="retention-confirm"
            >
              Remove older bodies
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
