"use client";

import type { SwarmItem, SwarmTaskState } from "@open-bot/shared";
import { Check, Clock, Loader2, Network, Square, X } from "lucide-react";
import Link from "next/link";
import { useTransition } from "react";
import { toast } from "sonner";
import { useComputer } from "@/components/computer/computer-panel";
import { DesktopView } from "@/components/computer/desktop-view";
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
import { stopSwarm } from "@/lib/actions";
import { cn, plainText } from "@/lib/utils";

const STATE: Record<SwarmTaskState, { label: string; className: string }> = {
  queued: { label: "Waiting to start", className: "text-muted-foreground" },
  running: { label: "Working", className: "text-live" },
  completed: { label: "Done", className: "text-done" },
  failed: { label: "Couldn't finish", className: "text-destructive" },
  stopped: { label: "Stopped", className: "text-muted-foreground" },
};

function StateIcon({ state }: { state: SwarmTaskState }) {
  switch (state) {
    case "queued":
      return <Clock className="size-3.5" />;
    case "running":
      return <span className="size-1.5 animate-tally rounded-full bg-live" />;
    case "completed":
      return <Check className="size-3.5" />;
    case "failed":
      return <X className="size-3.5" />;
    case "stopped":
      return <Square className="size-3" />;
  }
}

/** A helper's screen while it works, once it has opened one. */
function LiveScreen({ screenId }: { screenId: string }) {
  const { screens } = useComputer();
  const up = screens.some((screen) => screen.id === screenId && screen.state === "running");
  return up ? (
    <DesktopView screenId={screenId} mode="view" className="absolute inset-0" />
  ) : (
    <span className="absolute inset-0 flex items-center justify-center bg-bezel text-[12px] text-bezel-foreground/60">
      Not on its screen yet
    </span>
  );
}

function Tile({ task, index }: { task: SwarmItem["tasks"][number]; index: number }) {
  const state = STATE[task.state];
  const body = (
    <>
      <span className="relative block aspect-[16/10] w-full overflow-hidden rounded-[8px] bg-bezel ring-1 ring-border transition-all group-hover:ring-foreground/40">
        {task.state === "running" ? (
          <LiveScreen screenId={task.id} />
        ) : task.result && task.state === "completed" ? (
          <span className="absolute inset-0 overflow-hidden bg-card px-3 py-2.5 text-left text-[11.5px] leading-snug text-muted-foreground">
            {plainText(task.result)}
            <span className="absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-card to-transparent" />
          </span>
        ) : (
          <span className="absolute inset-0 flex items-center justify-center px-3 text-center text-[12px] text-bezel-foreground/60">
            {task.state === "queued" ? "Starting soon" : (task.result ?? state.label)}
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-1.5 text-[13px] font-medium text-foreground/90">
          <span className="font-mono text-[11.5px] font-normal text-muted-foreground">
            {index + 1}
          </span>
          <span className="truncate">{task.title}</span>
        </span>
        <span className={cn("flex items-center gap-1.5 text-[12px]", state.className)}>
          <StateIcon state={task.state} />
          {state.label}
        </span>
      </span>
    </>
  );
  return task.chatId ? (
    <Link
      href={`/chats/${task.chatId}`}
      className="group flex min-w-0 flex-col gap-2 rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      aria-label={`${task.title}: ${state.label}. Open its work.`}
      data-testid="swarm-task"
      data-state={task.state}
    >
      {body}
    </Link>
  ) : (
    <div className="flex min-w-0 flex-col gap-2" data-testid="swarm-task" data-state={task.state}>
      {body}
    </div>
  );
}

/** A job split across helpers working at the same time, each on its own screen. */
export function SwarmCard({ item, botName }: { item: SwarmItem; botName: string }) {
  const [pending, startTransition] = useTransition();
  const done = item.tasks.filter((task) => !["queued", "running"].includes(task.state)).length;
  const total = item.tasks.length;
  const running = item.state === "running";

  return (
    <section
      className="flex flex-col gap-3.5 rounded-xl border bg-card p-4"
      aria-label={`Swarm: ${item.title}`}
      data-testid="swarm"
      data-state={item.state}
    >
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-subtle text-muted-foreground">
          <Network className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[14px] font-medium">{item.title}</span>
          <span className="text-[12.5px] text-muted-foreground">
            {running
              ? `${total} helpers working at once, each on its own screen · ${done} of ${total} done`
              : item.state === "stopped"
                ? `You stopped it · ${done} of ${total} finished`
                : `${total} helpers finished · ${botName} merged their results`}
          </span>
        </div>
        {running && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm" disabled={pending}>
                {pending ? <Loader2 className="animate-spin" /> : <Square className="size-3" />}
                Stop
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Stop the swarm?</AlertDialogTitle>
                <AlertDialogDescription>
                  Every helper stops now, and {botName} won&apos;t get their results. What they
                  finished stays in their chats.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep going</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() =>
                    startTransition(async () => {
                      const result = await stopSwarm(item.swarmId);
                      if (!result.ok) toast.error(result.error);
                    })
                  }
                >
                  Stop helpers
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500",
            item.state === "stopped" ? "bg-muted-foreground/40" : "bg-done",
          )}
          style={{ width: `${(done / total) * 100}%` }}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {item.tasks.map((task, index) => (
          <Tile key={task.id} task={task} index={index} />
        ))}
      </div>
    </section>
  );
}
