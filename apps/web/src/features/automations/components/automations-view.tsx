"use client";

import { useQueryClient } from "@tanstack/react-query";
import { DAILY_CHECK_IN } from "@open-bot/domain";
import {
  CalendarClock,
  CalendarDays,
  ChevronDown,
  Eye,
  Loader2,
  Mail,
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
import { useAppState } from "@/features/app-shell";
import { useSchedules, useTriggers } from "../hooks";
import { attempt } from "@/lib/client/mutate";
import { api, orpc } from "@/lib/client/rpc";
import { ScheduleDialog } from "./schedule-dialog";
import { ScheduleRow } from "./schedules-list";
import { TriggerDialog } from "./trigger-dialog";
import { OfflineBanner, ROWS, useCanRun } from "./shared";
import { TriggerRow } from "./trigger-row";

type Kind = "schedule" | "watch" | "webhook" | "gmail" | "calendar";

/** Each kind of automation, as the "New automation" menu offers it. */
const KINDS: Record<Kind, { label: string; icon: LucideIcon }> = {
  schedule: { label: "Schedule", icon: CalendarClock },
  watch: { label: "Page watch", icon: Eye },
  webhook: { label: "Webhook", icon: Webhook },
  gmail: { label: "New mail in Gmail", icon: Mail },
  calendar: { label: "Calendar event", icon: CalendarDays },
};

type SectionKey = "schedule" | "watch" | "webhook" | "accounts";

const SECTIONS: Record<
  SectionKey,
  { heading: string; hint: string; icon: LucideIcon; actions: { kind: Kind; button: string }[] }
> = {
  schedule: {
    heading: "Schedules",
    hint: "Routines and reminders, at the times you set. Or ask a teammate: “Every weekday at 9, send me a briefing.”",
    icon: CalendarClock,
    actions: [{ kind: "schedule", button: "New schedule" }],
  },
  watch: {
    heading: "Page watches",
    hint: "Wake a teammate when a page changes: a price drops, something is back in stock, a new job is posted.",
    icon: Eye,
    actions: [{ kind: "watch", button: "Watch a page" }],
  },
  webhook: {
    heading: "Webhooks",
    hint: "A private URL that starts a teammate when another service calls it, like GitHub, Stripe, a form or a script.",
    icon: Webhook,
    actions: [{ kind: "webhook", button: "New webhook" }],
  },
  accounts: {
    heading: "Mail and calendar",
    hint: "Wake a teammate when mail arrives in your Gmail, or before an event on your Google Calendar.",
    icon: Mail,
    actions: [
      { kind: "gmail", button: "Watch Gmail" },
      { kind: "calendar", button: "Watch Calendar" },
    ],
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
      <TriggerDialog
        kind="gmail"
        botId={botId}
        open={open === "gmail"}
        onOpenChange={onOpenChange("gmail")}
      />
      <TriggerDialog
        kind="calendar"
        botId={botId}
        open={open === "calendar"}
        onOpenChange={onOpenChange("calendar")}
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
  section,
  count,
  onNew,
  children,
}: {
  section: SectionKey;
  count: number;
  onNew: (kind: Kind) => void;
  children: ReactNode;
}) {
  const { heading, hint, actions, icon: Icon } = SECTIONS[section];
  return (
    <section
      className="flex flex-col gap-3"
      aria-label={heading}
      data-testid={`section-${section}`}
    >
      <h2 className="flex items-center gap-2 font-heading text-[15px] font-semibold tracking-[-0.01em] text-foreground">
        {heading}
        {count > 0 && <span className="font-normal tabular-nums">{count}</span>}
      </h2>
      {count === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed px-4 py-4 sm:flex-row sm:items-center">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-subtle text-muted-foreground">
            <Icon className="size-4" />
          </span>
          <p className="min-w-0 flex-1 text-[13.5px] text-muted-foreground">{hint}</p>
          <div className="flex flex-wrap gap-2">
            {actions.map((action) => (
              <Button
                key={action.kind}
                variant="outline"
                size="sm"
                onClick={() => onNew(action.kind)}
              >
                <Plus />
                {action.button}
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <ul className={ROWS}>{children}</ul>
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
              const result = await attempt(
                api.schedules.setCheckIn({ teammateId: botId, on: checked }),
              );
              if (!result.ok) toast.error(result.error);
              else
                toast(checked ? "Daily check-in on" : "Daily check-in off", {
                  description: checked
                    ? `${name} checks in at 9 every morning, and stays quiet when there's nothing.`
                    : undefined,
                });
              await queryClient.invalidateQueries({ queryKey: orpc.schedules.key() });
            })
          }
        />
      </span>
    </label>
  );
}

/** Schedules, page watches, webhooks, and mail and calendar triggers, for everyone or one teammate. */
export function AutomationsView({ botId }: { botId?: string }) {
  const { data: schedules, isLoading: loadingSchedules } = useSchedules();
  const { data: triggers, isLoading: loadingTriggers } = useTriggers();
  const { data: state } = useAppState();
  const queryClient = useQueryClient();
  const canRun = useCanRun();
  const [open, setOpen] = useState<Kind | null>(null);
  const botOf = (id: string) => state?.bots.find((bot) => bot.id === id);
  const mine = <T extends { botId: string }>(rows: T[] | undefined) =>
    (rows ?? []).filter((row) => !botId || row.botId === botId);
  const scheduleRows = mine(schedules);
  const watches = mine(triggers).filter((row) => row.kind === "watch");
  const webhooks = mine(triggers).filter((row) => row.kind === "webhook");
  const accountTriggers = mine(triggers).filter(
    (row) => row.kind === "gmail" || row.kind === "calendar",
  );
  const refreshSchedules = () =>
    void queryClient.invalidateQueries({ queryKey: orpc.schedules.key() });
  const refreshTriggers = () =>
    void queryClient.invalidateQueries({ queryKey: orpc.triggers.key() });

  if (loadingSchedules || loadingTriggers)
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    );

  return (
    <div className="flex flex-col gap-9">
      {!canRun && <OfflineBanner />}
      {botId && (
        <div className="-mb-3 flex flex-col gap-4">
          <div className="flex justify-end">
            <NewAutomationMenu botId={botId} />
          </div>
          <CheckIn botId={botId} name={botOf(botId)?.name ?? "This teammate"} />
        </div>
      )}
      <Section section="schedule" count={scheduleRows.length} onNew={setOpen}>
        {scheduleRows.map((schedule) => (
          <ScheduleRow
            key={schedule.id}
            schedule={schedule}
            bot={botOf(schedule.botId)}
            refresh={refreshSchedules}
          />
        ))}
      </Section>
      <Section section="watch" count={watches.length} onNew={setOpen}>
        {watches.map((trigger) => (
          <TriggerRow
            key={trigger.id}
            trigger={trigger}
            bot={botOf(trigger.botId)}
            refresh={refreshTriggers}
          />
        ))}
      </Section>
      <Section section="accounts" count={accountTriggers.length} onNew={setOpen}>
        {accountTriggers.map((trigger) => (
          <TriggerRow
            key={trigger.id}
            trigger={trigger}
            bot={botOf(trigger.botId)}
            refresh={refreshTriggers}
          />
        ))}
      </Section>
      <Section section="webhook" count={webhooks.length} onNew={setOpen}>
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
