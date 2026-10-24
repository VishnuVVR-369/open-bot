"use client";

import { isRunActive } from "@open-bot/shared";
import { format } from "date-fns";
import { Check, CircleSlash, Clock, Loader2, Trash2, X } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ScheduleRunView } from "@/lib/types";
import { chatHref } from "@/lib/utils";

const RUN_STATUS: Record<string, string> = {
  completed: "Finished",
  failed: "Failed",
  interrupted: "Stopped",
  running: "Running",
  starting: "Starting",
  waiting: "Waiting for you",
  queued: "Starting",
};

/** How the last run went, under an automation's title. */
export const LAST_RUN_TEXT: Record<string, string> = {
  completed: "Last run finished",
  failed: "Last run failed",
  interrupted: "Last run was stopped",
  running: "Running now",
  starting: "Running now",
  waiting: "Waiting for you",
  queued: "Starting",
};

function RunIcon({ status }: { status: ScheduleRunView["status"] }) {
  if (status === "completed") return <Check className="size-3.5 text-done" />;
  if (status === "failed") return <X className="size-3.5 text-destructive" />;
  if (status === "interrupted") return <CircleSlash className="size-3.5 text-muted-foreground" />;
  if (status === "waiting") return <Clock className="size-3.5 text-waiting" />;
  return <Loader2 className="size-3.5 animate-spin text-live" />;
}

export function DetailLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[12px] font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </span>
  );
}

/** An automation's recent runs, each linking to the run in its chat. */
export function RunHistory({
  runs,
  isLoading,
  empty,
}: {
  runs: ScheduleRunView[] | undefined;
  isLoading: boolean;
  empty: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <DetailLabel>Recent runs</DetailLabel>
      {isLoading ? (
        <Skeleton className="h-16 w-full rounded-lg" />
      ) : !runs?.length ? (
        <p className="text-[13px] text-muted-foreground">{empty}</p>
      ) : (
        <ul className="-mx-2 flex flex-col" data-testid="automation-runs">
          {runs.map((run) => (
            <li key={run.id}>
              <Link
                href={chatHref(run.chatId, run.id)}
                className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] transition-colors hover:bg-muted/60"
                data-testid="automation-run"
              >
                <RunIcon status={run.status} />
                <span className="w-[136px] shrink-0 text-muted-foreground tabular-nums">
                  {format(new Date(run.createdAt), "EEE d MMM, h:mm a")}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {isRunActive(run.status) || !run.preview ? (
                    <span className="text-muted-foreground">{RUN_STATUS[run.status]}</span>
                  ) : (
                    run.preview
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A delete button that asks first. */
export function ConfirmDelete({
  title,
  description,
  onConfirm,
}: {
  title: string;
  description: string;
  onConfirm: () => Promise<void>;
}) {
  return (
    <AlertDialog>
      <Tooltip>
        <TooltipTrigger asChild>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Delete">
              <Trash2 />
            </Button>
          </AlertDialogTrigger>
        </TooltipTrigger>
        <TooltipContent>Delete</TooltipContent>
      </Tooltip>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** An icon button with a tooltip, for a row's actions. */
export function RowAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
