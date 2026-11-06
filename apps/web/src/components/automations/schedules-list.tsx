"use client";

import { describeCron } from "@open-bot/shared";
import { format, formatDistanceToNowStrict } from "date-fns";
import { ChevronRight, Play } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { BotAvatar } from "@/components/bot-avatar";
import { Switch } from "@/components/ui/switch";
import { deleteSchedule, runScheduleNow, setScheduleEnabled } from "@/lib/actions";
import { useScheduleRuns } from "@/lib/client/queries";
import type { BotSummary, ScheduleView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ScheduleDialog } from "./schedule-dialog";
import { DetailLabel, LAST_RUN_TEXT, RowAction, RowMenu, RunHistory, StateBadge } from "./shared";

function cadence(schedule: ScheduleView) {
  if (schedule.kind === "cron" && schedule.cron) return describeCron(schedule.cron);
  if (schedule.runAt) return `Once, ${format(new Date(schedule.runAt), "EEE MMM d, h:mm a")}`;
  return "Once";
}

/** What the schedule asks for, and how its recent runs went. */
function ScheduleDetails({ schedule }: { schedule: ScheduleView }) {
  const { data: history, isLoading } = useScheduleRuns(schedule.id, true);
  return (
    <div className="flex flex-col gap-4 border-t px-4 py-4 sm:pl-[68px]">
      <div className="flex flex-col gap-1">
        <DetailLabel>What to do</DetailLabel>
        <p className="text-[13.5px] whitespace-pre-wrap">{schedule.prompt}</p>
        <span className="text-[12.5px] text-muted-foreground">Times in {schedule.timezone}</span>
      </div>
      <RunHistory
        runs={history}
        isLoading={isLoading}
        empty="It hasn't run yet. Press play to try it now."
      />
    </div>
  );
}

export function ScheduleRow({
  schedule,
  bot,
  refresh,
}: {
  schedule: ScheduleView;
  bot: BotSummary | undefined;
  refresh: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const done = schedule.kind === "once" && Boolean(schedule.lastRunAt) && !schedule.enabled;

  return (
    <li className="rounded-xl bg-card shadow-raised" data-testid="schedule">
      <div className="flex flex-wrap items-center gap-4 px-4 py-3.5">
        {bot && <BotAvatar name={bot.name} color={bot.color} emoji={bot.emoji} size="md" />}
        <button
          type="button"
          className="group flex min-w-0 flex-1 basis-[calc(100%-3.5rem)] flex-col gap-0.5 text-left outline-none sm:basis-0"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          data-testid="schedule-toggle"
        >
          <span className="flex items-center gap-2">
            <span className="truncate text-[14.5px] font-medium group-hover:underline group-focus-visible:underline">
              {schedule.title}
            </span>
            {!schedule.enabled && <StateBadge>{done ? "Done" : "Paused"}</StateBadge>}
            {schedule.createdBy === "bot" && (
              <span className="shrink-0 text-[12px] text-muted-foreground">
                Set by {bot?.name ?? "a teammate"}
              </span>
            )}
            <ChevronRight
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                expanded && "rotate-90",
              )}
            />
          </span>
          <span className="truncate text-[13px] text-muted-foreground">
            {cadence(schedule)}
            {schedule.enabled && schedule.nextRunAt && (
              <>
                {" "}
                · next{" "}
                {formatDistanceToNowStrict(new Date(schedule.nextRunAt), { addSuffix: true })}
              </>
            )}
            {schedule.quiet && " · only news"}
          </span>
          {schedule.lastRun && (
            <span className="text-[12.5px] text-muted-foreground">
              {LAST_RUN_TEXT[schedule.lastRun.status] ?? "Last run"}
              {schedule.lastRunAt &&
                ` ${formatDistanceToNowStrict(new Date(schedule.lastRunAt), { addSuffix: true })}`}
            </span>
          )}
        </button>
        <div className="-my-1 ml-auto flex items-center gap-1 sm:my-0">
          <RowAction
            label="Run now"
            onClick={async () => {
              const result = await runScheduleNow(schedule.id);
              if (!result.ok) toast.error(result.error);
              else
                toast(`Started “${schedule.title}”`, {
                  description: `${bot?.name ?? "The bot"} is on it.`,
                });
              refresh();
            }}
          >
            <Play />
          </RowAction>
          {!done && (
            <Switch
              className="mx-1.5"
              checked={schedule.enabled}
              aria-label={schedule.enabled ? "Pause" : "Resume"}
              onCheckedChange={async (checked) => {
                const result = await setScheduleEnabled(schedule.id, checked);
                if (!result.ok) toast.error(result.error);
                refresh();
              }}
            />
          )}
          <RowMenu
            title={schedule.title}
            deleteDescription="It won't run again. Past runs stay in the Scheduled chat."
            onEdit={() => setEditing(true)}
            onDelete={async () => {
              const result = await deleteSchedule(schedule.id);
              if (!result.ok) toast.error(result.error);
              refresh();
            }}
          />
          <ScheduleDialog schedule={schedule} open={editing} onOpenChange={setEditing} />
        </div>
      </div>
      {expanded && <ScheduleDetails schedule={schedule} />}
    </li>
  );
}
