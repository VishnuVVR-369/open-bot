"use client";

import {
  cadenceCron,
  cadenceOf,
  describeCron,
  formatLocalDateTime,
  type Cadence,
} from "@open-bot/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import { useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { BotAvatar } from "@/components/bot-avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { createSchedule, updateSchedule } from "@/lib/actions";
import { queryKeys, useAppState } from "@/lib/client/queries";
import type { ScheduleView } from "@/lib/types";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function defaultDateTime() {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Create a schedule, or edit one when `schedule` is given. Opens from `trigger`, or from outside
 * with `open` and `onOpenChange`.
 */
export function ScheduleDialog({
  botId,
  schedule,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  botId?: string;
  schedule?: ScheduleView;
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { data: state } = useAppState();
  const bots = state?.bots ?? [];
  const defaultTimezone = state?.timezone ?? "UTC";
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;
  const [selectedBot, setSelectedBot] = useState(botId ?? "");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<"cron" | "once">("cron");
  const [cadence, setCadence] = useState<Cadence>("weekdays");
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState("1");
  const [custom, setCustom] = useState("0 9 * * 1-5");
  const [at, setAt] = useState(defaultDateTime);
  const [quiet, setQuiet] = useState(false);
  const [pending, startTransition] = useTransition();
  const queryClient = useQueryClient();
  // A schedule keeps the timezone it was made in; new ones use yours.
  const timezone = schedule?.timezone ?? defaultTimezone;

  // Start from the schedule (or a blank one) each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setSelectedBot(schedule?.botId ?? botId ?? "");
    setTitle(schedule?.title ?? "");
    setPrompt(schedule?.prompt ?? "");
    setKind(schedule?.kind ?? "cron");
    setQuiet(schedule?.quiet ?? false);
    const parsed = schedule?.cron
      ? cadenceOf(schedule.cron)
      : { cadence: "weekdays" as const, time: "09:00", weekday: "1" };
    setCadence(parsed.cadence);
    setTime(parsed.time);
    setWeekday(parsed.weekday);
    setCustom(schedule?.cron ?? "0 9 * * 1-5");
    setAt(
      schedule?.runAt && new Date(schedule.runAt).getTime() > Date.now()
        ? formatLocalDateTime(new Date(schedule.runAt), schedule.timezone)
        : defaultDateTime(),
    );
  }, [open, schedule, botId]);

  const cron = cadenceCron(cadence, time, weekday, custom);
  const summary = useMemo(() => (kind === "cron" ? describeCron(cron) : null), [kind, cron]);
  const botValue = selectedBot || bots[0]?.id || "";

  function submit() {
    startTransition(async () => {
      const input = {
        botId: botValue,
        title: title.trim(),
        prompt: prompt.trim(),
        cron: kind === "cron" ? cron : null,
        at: kind === "once" ? at : null,
        timezone,
        quiet: kind === "cron" && quiet,
      };
      const result = schedule
        ? await updateSchedule(schedule.id, input)
        : await createSchedule(input);
      if (!result.ok) {
        toast.error(schedule ? "Couldn't save the schedule" : "Couldn't schedule that", {
          description: result.error,
        });
        return;
      }
      toast(schedule ? "Schedule updated" : "Scheduled", {
        description: kind === "cron" ? (summary ?? cron) : "It runs once at the time you picked.",
      });
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {controlledOpen === undefined && (
        <DialogTrigger asChild>
          {trigger ?? (
            <Button disabled={bots.length === 0}>
              <Plus />
              New schedule
            </Button>
          )}
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{schedule ? "Edit schedule" : "New schedule"}</DialogTitle>
          <DialogDescription>
            The teammate gets this prompt at the set time, works on it in their Scheduled chat, and
            notifies you when it&apos;s done.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {(!botId || schedule) && (
            <div className="flex flex-col gap-2">
              <Label>Teammate</Label>
              <Select value={botValue} onValueChange={setSelectedBot}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose a teammate" />
                </SelectTrigger>
                <SelectContent>
                  {bots.map((bot) => (
                    <SelectItem key={bot.id} value={bot.id}>
                      <BotAvatar name={bot.name} color={bot.color} emoji={bot.emoji} size="xs" />
                      {bot.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="schedule-title">Title</Label>
            <Input
              id="schedule-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Morning briefing"
              maxLength={80}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="schedule-prompt">What to do</Label>
            <Textarea
              id="schedule-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Check my calendar and the news, and send me a short briefing for the day."
              className="min-h-24"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label>When</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              value={kind}
              onValueChange={(value) => value && setKind(value as "cron" | "once")}
              className="w-full"
            >
              <ToggleGroupItem value="cron" className="flex-1">
                Repeats
              </ToggleGroupItem>
              <ToggleGroupItem value="once" className="flex-1">
                Once
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          {kind === "cron" ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                <Select value={cadence} onValueChange={(value) => setCadence(value as Cadence)}>
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Every day</SelectItem>
                    <SelectItem value="weekdays">Weekdays</SelectItem>
                    <SelectItem value="weekly">Every week</SelectItem>
                    <SelectItem value="hourly">Every hour</SelectItem>
                    <SelectItem value="custom">Custom (cron)</SelectItem>
                  </SelectContent>
                </Select>
                {cadence === "weekly" && (
                  <Select value={weekday} onValueChange={setWeekday}>
                    <SelectTrigger className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WEEKDAYS.map((day, index) => (
                        <SelectItem key={day} value={String(index)}>
                          {day}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {cadence !== "custom" && (
                  <Input
                    type="time"
                    value={cadence === "hourly" ? `00:${time.split(":")[1] ?? "00"}` : time}
                    onChange={(e) => setTime(e.target.value)}
                    className="w-32"
                    aria-label="Time"
                  />
                )}
                {cadence === "custom" && (
                  <Input
                    value={custom}
                    onChange={(e) => setCustom(e.target.value)}
                    className="w-48 font-mono"
                    aria-label="Cron expression"
                  />
                )}
              </div>
              <p className="text-[12.5px] text-muted-foreground">
                {summary} · {timezone}
              </p>
              <label className="mt-1 flex cursor-pointer items-start justify-between gap-4 rounded-lg border px-3.5 py-3">
                <span className="flex flex-col gap-0.5">
                  <span className="text-[14px] font-medium">
                    Only tell me when there&apos;s news
                  </span>
                  <span className="text-[12.5px] text-muted-foreground">
                    For checks that often find nothing. Quiet runs don&apos;t notify you.
                  </span>
                </span>
                <Switch
                  checked={quiet}
                  onCheckedChange={setQuiet}
                  aria-label="Only tell me when there's news"
                />
              </label>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <Input
                type="datetime-local"
                value={at}
                onChange={(e) => setAt(e.target.value)}
                className="w-60"
                aria-label="Date and time"
              />
              <p className="text-[12.5px] text-muted-foreground">In {timezone}</p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={pending || !title.trim() || !prompt.trim() || !botValue}
          >
            {pending && <Loader2 className="animate-spin" />}
            {schedule ? "Save changes" : "Schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
