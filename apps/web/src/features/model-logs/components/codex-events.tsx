"use client";

import type { CodexEventSummary } from "@open-bot/api";
import { format } from "date-fns";
import { ArrowLeft, ArrowRight, ChevronDown } from "lucide-react";
import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatSize } from "../format";
import { useRunEvent, useRunEvents } from "../hooks";
import { JsonBlock } from "./text-block";

function deltaTotal(counts: CodexEventSummary["deltaCounts"]): number {
  if (!counts) return 0;
  let total = 0;
  for (const methods of Object.values(counts))
    for (const count of Object.values(methods)) total += count;
  return total;
}

function Payload({ eventId }: { eventId: string }) {
  const payload = useRunEvent(eventId, true);
  if (payload.data) return <JsonBlock json={payload.data.payload} label="Payload" />;
  if (payload.error)
    return (
      <p className="text-[12.5px] text-destructive">
        Couldn&apos;t load it. {payload.error.message}
      </p>
    );
  return <Skeleton className="h-16 w-full rounded-lg" />;
}

function EventRow({ event }: { event: CodexEventSummary }) {
  const [open, setOpen] = useState(false);
  const toCodex = event.direction === "to_codex";
  const Arrow = toCodex ? ArrowRight : ArrowLeft;
  const deltas = deltaTotal(event.deltaCounts);
  return (
    <li className="flex min-w-0 flex-col" data-testid="codex-event">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-subtle"
      >
        <span className="w-[92px] shrink-0 text-muted-foreground tabular-nums">
          {format(new Date(event.at), "h:mm:ss.SSS")}
        </span>
        <Arrow
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-label={toCodex ? "To Codex" : "From Codex"}
        />
        <span className="min-w-0 truncate font-mono">{event.method}</span>
        <span className="hidden shrink-0 text-muted-foreground sm:inline">{event.kind}</span>
        {deltas > 0 && (
          <span className="hidden shrink-0 text-muted-foreground sm:inline">
            · {deltas} {deltas === 1 ? "delta" : "deltas"}
          </span>
        )}
        <span
          className={cn(
            "ml-auto shrink-0 tabular-nums",
            event.omitted ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {event.omitted
            ? "Not stored"
            : event.bodiesExpiredAt
              ? "Expired"
              : formatSize(event.size)}
        </span>
      </button>
      {open && (
        <div className="flex min-w-0 flex-col gap-2 py-2 pl-2 sm:pl-[108px]">
          {event.omitted ? (
            <p className="text-[12.5px] text-muted-foreground">
              Only a note was kept for this message: {event.omitted}, {formatSize(event.size)}.
            </p>
          ) : (
            <>
              {event.bodiesExpiredAt && (
                <p className="text-[12.5px] text-muted-foreground">
                  Its body expired on {format(new Date(event.bodiesExpiredAt), "MMM d, yyyy")}. What
                  is left says what the message was about and how it ended.
                </p>
              )}
              <Payload eventId={event.id} />
            </>
          )}
          {event.itemId && (
            <p className="font-mono text-[11.5px] text-muted-foreground [overflow-wrap:anywhere]">
              Item {event.itemId}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function EventList({ runId }: { runId: string }) {
  const events = useRunEvents(runId, true);
  if (events.data)
    return (
      <ol className="flex min-w-0 flex-col" data-testid="codex-events">
        {events.data.map((event) => (
          <EventRow key={event.id} event={event} />
        ))}
      </ol>
    );
  if (events.error)
    return (
      <p className="text-[12.5px] text-destructive">
        Couldn&apos;t load the messages. {events.error.message}
      </p>
    );
  return <Skeleton className="h-24 w-full rounded-lg" />;
}

/** Every message between the worker and Codex for the run, closed until you open it. */
export function CodexEvents({ runId, count }: { runId: string; count: number }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        disabled={count === 0}
        className="flex items-center gap-2 self-start text-[15px] font-semibold disabled:text-muted-foreground"
        data-testid="codex-events-toggle"
      >
        <ChevronDown className={cn("size-4 transition-transform", !open && "-rotate-90")} />
        Codex messages
        <span className="text-[13px] font-normal text-muted-foreground tabular-nums">{count}</span>
      </button>
      <p className="max-w-[70ch] text-[13px] text-muted-foreground">
        What the worker and Codex said to each other during the run, with credentials removed.
        Streaming pieces are counted, not kept.
      </p>
      {open && <EventList runId={runId} />}
    </section>
  );
}
