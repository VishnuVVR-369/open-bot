"use client";

import {
  AUTONOMY_OPTIONS,
  BOT_COLORS,
  describeCron,
  TEAMMATE_TEMPLATES,
  type Autonomy,
} from "@open-bot/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { BotAvatar } from "@/components/bot-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { createBot, importTeammate, updateBot } from "@/lib/actions";
import { queryKeys } from "@/lib/client/queries";
import { cn } from "@/lib/utils";

export interface BotFormValues {
  name: string;
  role: string;
  instructions: string;
  color: string;
  emoji: string;
  autonomy: Autonomy;
}

export function BotForm({
  editing,
  initial,
  submitLabel,
}: {
  /** The teammate being edited, at the revision the form loaded; none for a new one. */
  editing?: { botId: string; revision: string };
  initial: BotFormValues;
  submitLabel: string;
}) {
  const [values, setValues] = useState<BotFormValues>(initial);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [starterIds, setStarterIds] = useState<string[]>([]);
  const template = TEAMMATE_TEMPLATES.find((entry) => entry.id === templateId);
  const importInput = useRef<HTMLInputElement>(null);
  const [importing, startImport] = useTransition();

  function importFile(file: File) {
    startImport(async () => {
      if (file.size > 2_000_000) {
        toast.error("Couldn't import it", { description: "Teammate files are smaller than that." });
        return;
      }
      const result = await importTeammate(await file.text());
      if (!result.ok) {
        toast.error("Couldn't import it", { description: result.error });
        return;
      }
      toast(`${result.data.name} joined the team`, {
        description:
          result.data.paused > 0
            ? `Their ${result.data.paused === 1 ? "automation is" : `${result.data.paused} automations are`} paused. Turn them on in Automations.`
            : undefined,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.state });
      router.push(`/chats/${result.data.chatId}`);
    });
  }
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const queryClient = useQueryClient();
  const set = <K extends keyof BotFormValues>(key: K, value: BotFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  function submit() {
    startTransition(async () => {
      if (editing) {
        const result = await updateBot(editing.botId, values, editing.revision);
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        toast("Saved", {
          description: `${values.name} uses the new settings from the next message.`,
        });
        await queryClient.invalidateQueries({ queryKey: queryKeys.state });
        router.refresh();
        return;
      }
      const result = await createBot(values, { templateId, ids: starterIds });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const failed = (kind: "skill" | "schedule") =>
        result.data.failed.filter((entry) => entry.kind === kind).length;
      const started = result.data.schedules;
      if (failed("skill") > 0)
        toast.warning(`${values.name} is ready, without some of its skills`, {
          description: "Add them in Skills whenever you like.",
        });
      else if (failed("schedule") > 0)
        toast.warning(`${values.name} is ready, without some starter automations`, {
          description: "Add them in Automations whenever you like.",
        });
      else if (started > 0)
        toast(
          `${values.name} starts with ${started === 1 ? "an automation" : `${started} automations`}`,
          {
            description: "Change or pause them anytime in Automations.",
          },
        );
      await queryClient.invalidateQueries({ queryKey: queryKeys.state });
      router.push(`/chats/${result.data.chatId}`);
    });
  }

  return (
    <form
      className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_280px]"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-col gap-7">
        {!editing && (
          <div className="flex flex-col gap-2.5">
            <span className="text-[13px] font-medium text-muted-foreground">Start from</span>
            <div className="flex flex-wrap gap-2">
              {TEAMMATE_TEMPLATES.map((entry) => (
                <button
                  type="button"
                  key={entry.id}
                  aria-pressed={entry.id === templateId}
                  onClick={() => {
                    setValues((current) => ({
                      ...current,
                      name: entry.name,
                      role: entry.role,
                      emoji: entry.emoji,
                      autonomy: entry.autonomy,
                      instructions: entry.instructions,
                    }));
                    setTemplateId(entry.id);
                    setStarterIds(entry.starters.map((starter) => starter.id));
                  }}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border bg-card px-3 py-1.5 text-[13px] transition-colors hover:border-foreground/30 hover:bg-muted",
                    entry.id === templateId && "border-foreground/50 bg-muted",
                  )}
                >
                  <span>{entry.emoji}</span>
                  {entry.label}
                </button>
              ))}
              <button
                type="button"
                disabled={importing}
                onClick={() => importInput.current?.click()}
                className="flex items-center gap-1.5 rounded-full border border-dashed bg-card px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted hover:text-foreground disabled:opacity-60"
              >
                {importing ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Upload className="size-3.5" />
                )}
                Import a file
              </button>
              <input
                ref={importInput}
                type="file"
                accept=".json,application/json"
                hidden
                data-testid="import-teammate"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) importFile(file);
                }}
              />
            </div>
          </div>
        )}

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="bot-name">Name</Label>
            <Input
              id="bot-name"
              value={values.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Nova"
              maxLength={40}
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="bot-role">Job</Label>
            <Input
              id="bot-role"
              value={values.role}
              onChange={(e) => set("role", e.target.value)}
              placeholder="research assistant"
              maxLength={80}
              required
            />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="bot-instructions">What they&apos;re responsible for</Label>
          <Textarea
            id="bot-instructions"
            value={values.instructions}
            onChange={(e) => set("instructions", e.target.value)}
            placeholder="Describe the job: what to do, how you like it done, and what to stay away from."
            className="min-h-36 text-[14px] leading-relaxed"
          />
          <p className="text-[12.5px] text-muted-foreground">
            This becomes their instructions file. They also keep their own memory of what they learn
            about you.
          </p>
        </div>

        {template && template.starters.length > 0 && (
          <div className="flex flex-col gap-2.5" data-testid="starter-automations">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Starter automations</span>
              <span className="text-[12.5px] text-muted-foreground">
                So {values.name.trim() || "they"} can get going on their own. Change or pause them
                anytime in Automations.
              </span>
            </div>
            <div className="flex flex-col divide-y rounded-xl border bg-card">
              {template.starters.map((starter) => {
                const on = starterIds.includes(starter.id);
                return (
                  <label
                    key={starter.id}
                    className="flex cursor-pointer items-start gap-3 px-4 py-3"
                  >
                    <Switch
                      checked={on}
                      onCheckedChange={(checked) =>
                        setStarterIds((current) =>
                          checked
                            ? [...current, starter.id]
                            : current.filter((id) => id !== starter.id),
                        )
                      }
                      aria-label={starter.title}
                      className="mt-0.5"
                    />
                    <span className={cn("flex min-w-0 flex-col gap-0.5", !on && "opacity-60")}>
                      <span className="text-[14px] font-medium">
                        {starter.title}
                        <span className="font-normal text-muted-foreground">
                          {" "}
                          · {describeCron(starter.cron)}
                        </span>
                      </span>
                      <span className="text-[13px] leading-relaxed text-muted-foreground">
                        {starter.prompt}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        <fieldset className="flex flex-col gap-2.5">
          <legend className="mb-2.5 text-sm font-medium">When to ask you first</legend>
          <div className="grid gap-2">
            {AUTONOMY_OPTIONS.map((option) => {
              const checked = values.autonomy === option.value;
              return (
                <label
                  key={option.value}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-xl border bg-card px-4 py-3 transition-colors hover:bg-muted/40",
                    checked && "border-foreground/50 bg-muted/40",
                  )}
                >
                  <input
                    type="radio"
                    name="autonomy"
                    value={option.value}
                    checked={checked}
                    onChange={() => set("autonomy", option.value)}
                    className="sr-only"
                  />
                  <span
                    className={cn(
                      "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                      checked && "border-foreground bg-foreground",
                    )}
                  >
                    {checked && <span className="size-1.5 rounded-full bg-background" />}
                  </span>
                  <span className="flex flex-col gap-0.5">
                    <span className="text-[14px] font-medium">{option.label}</span>
                    <span className="text-[13px] text-muted-foreground">{option.description}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="flex gap-2">
          <Button
            type="submit"
            size="lg"
            disabled={pending || !values.name.trim() || !values.role.trim()}
          >
            {pending && <Loader2 className="animate-spin" />}
            {submitLabel}
          </Button>
          <Button type="button" variant="ghost" size="lg" onClick={() => router.back()}>
            Cancel
          </Button>
        </div>
      </div>

      <aside className="flex flex-col gap-6 lg:sticky lg:top-8 lg:self-start">
        <div className="flex flex-col items-center gap-3 rounded-2xl border bg-card px-6 py-8 text-center">
          <BotAvatar
            name={values.name || "?"}
            color={values.color}
            emoji={values.emoji}
            size="xl"
          />
          <div className="flex flex-col gap-0.5">
            <span className="font-heading text-lg font-semibold">{values.name || "Unnamed"}</span>
            <span className="text-[13px] text-muted-foreground">{values.role || "No job yet"}</span>
          </div>
        </div>
        <div className="flex flex-col gap-2.5">
          <Label>Color</Label>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Color">
            {BOT_COLORS.map((color) => (
              <button
                type="button"
                key={color}
                role="radio"
                aria-checked={values.color === color}
                aria-label={color}
                onClick={() => set("color", color)}
                className="flex size-7 items-center justify-center rounded-full ring-offset-2 ring-offset-surface transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                style={{
                  backgroundColor: color,
                  boxShadow:
                    values.color === color
                      ? `0 0 0 2px var(--surface), 0 0 0 4px ${color}`
                      : undefined,
                }}
              >
                {values.color === color && <Check className="size-4 text-white" />}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="bot-emoji">Emoji (optional)</Label>
          <Input
            id="bot-emoji"
            value={values.emoji}
            onChange={(e) => set("emoji", [...e.target.value].slice(-2).join(""))}
            placeholder="Initials if empty"
            className="w-40"
          />
        </div>
      </aside>
    </form>
  );
}
