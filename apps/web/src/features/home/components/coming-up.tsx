"use client";

import { format, isToday, isTomorrow } from "date-fns";
import { BotAvatar } from "@/components/bot-avatar";
import { useSchedules } from "@/features/automations";
import { useAppState } from "@/features/app-shell";
import { isComputerOnline, runIsHeldBack, WAITING_FOR_COMPUTER } from "@/lib/status";
import { SideHeading } from "./side-heading";

/** "Today 4:00 PM", "Tomorrow 8:00 AM", or "Mon 8:00 AM" further out. */
function nextRunLabel(date: Date): string {
  const time = format(date, "h:mm a");
  if (isToday(date)) return `Today ${time}`;
  if (isTomorrow(date)) return `Tomorrow ${time}`;
  return format(date, "EEE h:mm a");
}

/** The next few scheduled runs, so you know what your teammates will do without asking. */
export function ComingUp({ now }: { now: number | null }) {
  const { data: state } = useAppState();
  const { data: schedules } = useSchedules();
  const online = isComputerOnline(state);
  const next = (schedules ?? [])
    .filter((schedule) => schedule.enabled && schedule.nextRunAt)
    .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))
    .slice(0, 3);
  if (!state || next.length === 0) return null;
  return (
    <section className="flex flex-col gap-3" aria-label="Coming up" data-testid="coming-up">
      <SideHeading title="Coming up" href="/automations" label="Automations" />
      <ol className="divide-y divide-border/70 overflow-hidden rounded-xl bg-card shadow-raised">
        {next.map((schedule) => {
          const bot = state.teammates.find((entry) => entry.id === schedule.teammateId);
          return (
            <li key={schedule.id} className="flex items-center gap-3 px-3.5 py-2.5">
              {bot ? (
                <BotAvatar name={bot.name} color={bot.color} emoji={bot.emoji} size="sm" />
              ) : (
                <span className="size-7 shrink-0 rounded-[8px] bg-subtle" />
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13.5px] font-medium">{schedule.title}</span>
                <span className="truncate text-[12.5px] text-muted-foreground">
                  {bot?.name ?? "Former teammate"}
                </span>
              </span>
              <span className="shrink-0 text-[12.5px] text-muted-foreground tabular-nums">
                {now !== null && runIsHeldBack(schedule.nextRunAt!, now, online)
                  ? WAITING_FOR_COMPUTER
                  : nextRunLabel(new Date(schedule.nextRunAt!))}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
