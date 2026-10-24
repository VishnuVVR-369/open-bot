"use client";

import { useQueryClient } from "@tanstack/react-query";
import { DAILY_CHECK_IN } from "@open-bot/shared";
import {
  CalendarClock,
  ChevronDown,
  Eye,
  Loader2,
  Plus,
  Sunrise,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { setCheckIn } from "@/lib/actions";
import { queryKeys, useAppState, useSchedules, useTriggers } from "@/lib/client/queries";
import { ScheduleDialog } from "./schedule-dialog";
import { ScheduleRow } from "./schedules-list";
import { TriggerDialog } from "./trigger-dialog";
import { TriggerRow } from "./trigger-row";

type Kind = "schedule" | "watch" | "webhook";

const KINDS: Record<
  Kind,
  { label: string; icon: LucideIcon; heading: string; hint: string; button: string }
> = {
  schedule: {
    label: "Schedule",
    icon: CalendarClock,
    heading: "Schedules",
    hint: "Routines and reminders, at the times you set. Or ask a teammate: “Every weekday at 9, send me a briefing.”",
    button: "New schedule",
  },
  watch: {
    label: "Page watch",
    icon: Eye,
    heading: "Page watches",
    hint: "Wake a teammate when a page changes: a price drops, something is back in stock, a new job is posted.",
    button: "Watch a page",
  },
  webhook: {
    label: "Webhook",
    icon: Webhook,
    heading: "Webhooks",
    hint: "A private URL that starts a teammate when another service calls it, like GitHub, Stripe, a form or a script.",
    button: "New webhook",
  },
};

/** The dialog for a new automation of each kind, opened from a menu or an empty section. */
function NewDialogs({
  open,
  setOpen,
  botId,
}: {
  open: Kind | null;
  setOpen: (kind: Kind | null) => void;
  botId?: string;
}) {
  const onOpenChange = (kind: Kind) => (value: boolean) => setOpen(value ? kind : null);
  return (
    <>
      <ScheduleDialog
        botId={botId}
        open={open === "schedule"}
        onOpenChange={onOpenChange("schedule")}
      />
      <TriggerDialog
        kind="watch"
        botId={botId}
        open={open === "watch"}
        onOpenChange={onOpenChange("watch")}
      />
      <TriggerDialog
        kind="webhook"
        botId={botId}
        open={open === "webhook"}
        onOpenChange={onOpenChange("webhook")}
      />
    </>
  );
}

/** The "New automation" menu, for a page header. */
export function NewAutomationMenu({ botId }: { botId?: string }) {
  const { data: state } = useAppState();
  const [open, setOpen] = useState<Kind | null>(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button disabled={!state?.bots.length}>
            <Plus />
            New automation
            <ChevronDown className="-mr-1 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {(Object.keys(KINDS) as Kind[]).map((kind) => {
            const Icon = KINDS[kind].icon;
            return (
              <DropdownMenuItem key={kind} onSelect={() => setOpen(kind)}>
                <Icon />
                {KINDS[kind].label}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <NewDialogs open={open} setOpen={setOpen} botId={botId} />
    </>
  );
}

function Section({
  kind,
  count,
  onNew,
  children,
}: {
  kind: Kind;
  count: number;
  onNew: () => void;
  children: ReactNode;
}) {
  const { heading, hint, button, icon: Icon } = KINDS[kind];
  return (
    <section className="flex flex-col gap-3" aria-label={heading} data-testid={`section-${kind}`}>
      <h2 className="flex items-center gap-2 text-[13px] font-medium tracking-wide text-muted-foreground uppercase">
        {heading}
        {count > 0 && <span className="font-normal tabular-nums">{count}</span>}
      </h2>
      {count === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed px-4 py-4 sm:flex-row sm:items-center">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-subtle text-muted-foreground">
            <Icon className="size-4" />
          </span>
          <p className="min-w-0 flex-1 text-[13.5px] text-muted-foreground">{hint}</p>
          <Button variant="outline" size="sm" onClick={onNew}>
            <Plus />
            {button}
          </Button>
        </div>
      ) : (
        <ul className="flex flex-col gap-2.5">{children}</ul>
      )}
    </section>
  );
}

/** A teammate's daily check-in, which only speaks up when something needs you. */
function CheckIn({ botId, name }: { botId: string; name: string }) {
  const { data: schedules } = useSchedules();
  const queryClient = useQueryClient();
  const [pending, startTransition] = useTransition();
  const on = (schedules ?? []).some(
    (row) => row.botId === botId && row.title === DAILY_CHECK_IN.title && row.quiet && row.enabled,
  );
  return (
    <label
      className="flex cursor-pointer items-start gap-3.5 rounded-xl border bg-card px-4 py-3.5"
      data-testid="check-in"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-subtle text-muted-foreground">
        <Sunrise className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[14px] font-medium">Daily check-in</span>
        <span className="text-[13px] text-muted-foreground">
          Every morning at 9, {name} looks over their area for deadlines, renewals and things
          waiting on you, and tells you only when something needs you.
        </span>
      </span>
      <span className="flex items-center gap-2 pt-1">
        {pending && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        <Switch
          checked={on}
          disabled={pending || !schedules}
          aria-label="Daily check-in"
          onCheckedChange={(checked) =>
            startTransition(async () => {
              const result = await setCheckIn(botId, checked);
              if (!result.ok) toast.error(result.error);
              else
                toast(checked ? "Daily check-in on" : "Daily check-in off", {
                  description: checked
                    ? `${name} checks in at 9 every morning, and stays quiet when there's nothing.`
                    : undefined,
                });
              await queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
            })
          }
        />
      </span>
    </label>
  );
}

/** Schedules, page watches and webhooks, for everyone or one teammate. */
export function AutomationsView({ botId }: { botId?: string }) {
  const { data: schedules, isLoading: loadingSchedules } = useSchedules();
  const { data: triggers, isLoading: loadingTriggers } = useTriggers();
  const { data: state } = useAppState();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<Kind | null>(null);
  const botOf = (id: string) => state?.bots.find((bot) => bot.id === id);
  const mine = <T extends { botId: string }>(rows: T[] | undefined) =>
    (rows ?? []).filter((row) => !botId || row.botId === botId);
  const scheduleRows = mine(schedules);
  const watches = mine(triggers).filter((row) => row.kind === "watch");
  const webhooks = mine(triggers).filter((row) => row.kind === "webhook");
  const refreshSchedules = () =>
    void queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
  const refreshTriggers = () =>
    void queryClient.invalidateQueries({ queryKey: queryKeys.triggers });

  if (loadingSchedules || loadingTriggers)
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    );

  return (
    <div className="flex flex-col gap-9">
      {botId && (
        <div className="-mb-3 flex flex-col gap-4">
          <div className="flex justify-end">
            <NewAutomationMenu botId={botId} />
          </div>
          <CheckIn botId={botId} name={botOf(botId)?.name ?? "This teammate"} />
        </div>
      )}
      <Section kind="schedule" count={scheduleRows.length} onNew={() => setOpen("schedule")}>
        {scheduleRows.map((schedule) => (
          <ScheduleRow
            key={schedule.id}
            schedule={schedule}
            bot={botOf(schedule.botId)}
            refresh={refreshSchedules}
          />
        ))}
      </Section>
      <Section kind="watch" count={watches.length} onNew={() => setOpen("watch")}>
        {watches.map((trigger) => (
          <TriggerRow
            key={trigger.id}
            trigger={trigger}
            bot={botOf(trigger.botId)}
            refresh={refreshTriggers}
          />
        ))}
      </Section>
      <Section kind="webhook" count={webhooks.length} onNew={() => setOpen("webhook")}>
        {webhooks.map((trigger) => (
          <TriggerRow
            key={trigger.id}
            trigger={trigger}
            bot={botOf(trigger.botId)}
            refresh={refreshTriggers}
          />
        ))}
      </Section>
      <NewDialogs open={open} setOpen={setOpen} botId={botId} />
    </div>
  );
}
