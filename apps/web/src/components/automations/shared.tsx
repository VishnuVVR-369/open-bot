"use client";

import { isRunActive } from "@open-bot/shared";
import { format } from "date-fns";
import { Check, CircleSlash, Clock, Ellipsis, Loader2, Pencil, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
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
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  if (status === "waiting") return <Clock className="size-3.5 text-attention-ink" />;
  return <Loader2 className="size-3.5 animate-spin text-working" />;
}

export function DetailLabel({ children }: { children: ReactNode }) {
  return <span className="text-[12.5px] font-medium text-muted-foreground">{children}</span>;
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
                  {format(new Date(run.createdAt), "EEE MMM d, h:mm a")}
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

/**
 * An automation row's less frequent actions behind "...": edit, and delete after asking.
 * The edit dialog is the row's own, opened through `onEdit`.
 */
export function RowMenu({
  title,
  deleteDescription,
  onEdit,
  onDelete,
}: {
  title: string;
  deleteDescription: string;
  onEdit: () => void;
  onDelete: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`More actions for ${title}`}
            className="text-muted-foreground"
          >
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil /> Edit
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
            <Trash2 /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{title}”?</AlertDialogTitle>
            <AlertDialogDescription>{deleteDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** "Paused" or "Done" beside an automation's title, so an off row still reads clearly. */
export function StateBadge({ children }: { children: ReactNode }) {
  return (
    <span
      className="shrink-0 rounded-full bg-foreground/[0.06] px-2 py-px text-[11.5px] font-medium text-muted-foreground"
      data-testid="automation-state"
    >
      {children}
    </span>
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
          className="text-muted-foreground hover:text-foreground"
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
