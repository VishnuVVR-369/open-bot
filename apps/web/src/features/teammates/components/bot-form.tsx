"use client";

import {
  type Autonomy,
  AUTONOMY_OPTIONS,
  TEAMMATE_COLORS,
  type TeammateSetupKind,
  describeCron,
  TEAMMATE_TEMPLATES,
} from "@open-bot/domain";
import { MAX_TEAMMATE_FILE } from "@open-bot/api";
import { useQueryClient } from "@tanstack/react-query";
import { Check, CircleCheck, Loader2, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { BotAvatar } from "@/components/bot-avatar";
import { MarkdownText } from "@/components/markdown-text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { attempt } from "@/lib/client/mutate";
import { api, orpc } from "@/lib/client/rpc";
import { cn } from "@/lib/utils";

export interface BotFormValues {
  name: string;
  role: string;
  instructions: string;
  color: string;
  emoji: string;
  autonomy: Autonomy;
}

/** When each teammate was last saved here, so the form can say so after it reloads. */
const savedAt = new Map<string, number>();
const SAVED_FOR_MS = 5000;

/** The last character typed, whole: one emoji, even one built from several code points. */
function lastGlyph(text: string) {
  const glyphs = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)];
  return glyphs.at(-1)?.segment ?? "";
}

function sameValues(a: BotFormValues, b: BotFormValues) {
  return (Object.keys(a) as (keyof BotFormValues)[]).every((key) => a[key] === b[key]);
}

/**
 * A teammate's instructions: a Markdown file, written as prose in the text face, with a preview
 * that shows the headings and lists the way they read.
 */
function InstructionsField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [view, setView] = useState<"write" | "preview">("write");
  return (
    <Tabs
      value={view}
      onValueChange={(next) => setView(next as "write" | "preview")}
      className="gap-2"
    >
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="bot-instructions">What they&apos;re responsible for</Label>
        <TabsList aria-label="Instructions view" className="h-7 group-data-horizontal/tabs:h-7">
          <TabsTrigger value="write" className="px-2.5 text-[12.5px]">
            Write
          </TabsTrigger>
          <TabsTrigger value="preview" className="px-2.5 text-[12.5px]">
            Preview
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="write">
        <Textarea
          id="bot-instructions"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Describe the job: what to do, how you like it done, and what to stay away from."
          // Room between lines so lists and "## Headings" stay easy to scan.
          className="min-h-36 px-3.5 py-3 font-sans text-[14.5px] leading-[22px] md:text-[14.5px]"
          spellCheck
        />
      </TabsContent>
      <TabsContent
        value="preview"
        className="min-h-36 rounded-lg border px-3.5 py-3 text-[14.5px]"
        data-testid="instructions-preview"
      >
        {value.trim() ? (
          <MarkdownText text={value} />
        ) : (
          <p className="text-muted-foreground">Nothing to preview yet.</p>
        )}
      </TabsContent>
      <p className="text-[12.5px] text-muted-foreground">
        This becomes their instructions file. They also keep their own memory of what they learn
        about you.
      </p>
    </Tabs>
  );
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
  const [baseline, setBaseline] = useState<BotFormValues>(initial);
  const dirty = !sameValues(values, baseline);
  const [justSaved, setJustSaved] = useState(() => {
    const at = editing ? savedAt.get(editing.botId) : undefined;
    return at !== undefined && Date.now() - at < SAVED_FOR_MS;
  });
  useEffect(() => {
    if (!justSaved) return;
    const timer = setTimeout(() => setJustSaved(false), SAVED_FOR_MS);
    return () => clearTimeout(timer);
  }, [justSaved]);
  // Leaving with unsaved edits asks first.
  useEffect(() => {
    if (!editing || !dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [editing, dirty]);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [starterIds, setStarterIds] = useState<string[]>([]);
  const template = TEAMMATE_TEMPLATES.find((entry) => entry.id === templateId);
  const importInput = useRef<HTMLInputElement>(null);
  const [importing, startImport] = useTransition();

  function importFile(file: File) {
    startImport(async () => {
      if (file.size > MAX_TEAMMATE_FILE) {
        toast.error("Couldn't import it", { description: "Teammate files are smaller than that." });
        return;
      }
      const result = await attempt(api.teammates.import({ file: await file.text() }));
      if (!result.ok) {
        toast.error("Couldn't import it", { description: result.error });
        return;
      }
      toast(`${result.data.name} joined the team`, {
        description:
          result.data.paused > 0
            ? `Their ${result.data.paused === 1 ? "automation is" : `${result.data.paused} automations are`} off. Turn them on in Automations.`
            : undefined,
      });
      await queryClient.invalidateQueries({ queryKey: orpc.app.state.key() });
      router.push(`/chats/${result.data.chatId}`);
    });
  }
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const queryClient = useQueryClient();
  const set = <K extends keyof BotFormValues>(key: K, value: BotFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const complete = Boolean(values.name.trim() && values.role.trim());
  // What a new teammate still needs before it can be created, said beside the disabled button.
  const missing = complete
    ? null
    : !values.name.trim() && !values.role.trim()
      ? "Add a name and a job to continue"
      : !values.name.trim()
        ? "Add a name to continue"
        : "Add a job to continue";
  const canSubmit = !pending && complete && (!editing || dirty);
  // Nothing to save on a teammate: the bar only says so, and stays at the end of the form.
  const idle = Boolean(editing) && !dirty && !pending && !justSaved;

  function submit() {
    startTransition(async () => {
      if (editing) {
        const result = await attempt(
          api.teammates.update({
            teammateId: editing.botId,
            profile: values,
            revision: editing.revision,
          }),
        );
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        savedAt.set(editing.botId, Date.now());
        setBaseline(values);
        setJustSaved(true);
        toast("Saved", {
          description: `${values.name} uses the new settings from the next message.`,
        });
        await queryClient.invalidateQueries({ queryKey: orpc.app.state.key() });
        router.refresh();
        return;
      }
      const result = await attempt(
        api.teammates.create({ profile: values, templateId, starterIds }),
      );
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const failed = (kind: TeammateSetupKind) =>
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
      await queryClient.invalidateQueries({ queryKey: orpc.app.state.key() });
      router.push(`/chats/${result.data.chatId}`);
    });
  }

  return (
    <form
      className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_300px]"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) submit();
      }}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "s") {
          event.preventDefault();
          if (canSubmit) submit();
        }
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
              placeholder="e.g. Nova"
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
              placeholder="e.g. Research assistant"
              maxLength={80}
              required
            />
          </div>
        </div>

        <InstructionsField
          value={values.instructions}
          onChange={(value) => set("instructions", value)}
        />

        {template && template.starters.length > 0 && (
          <div className="flex flex-col gap-2.5" data-testid="starter-automations">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Starter automations</span>
              <span className="text-[12.5px] text-muted-foreground">
                So {values.name.trim() || "they"} can get going on their own. Change or pause them
                anytime in Automations.
              </span>
            </div>
            <div className="flex flex-col divide-y divide-border/70 rounded-xl border bg-card">
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
          <legend className="mb-2.5 text-sm font-medium">When they ask you first</legend>
          <div className="grid gap-2">
            {AUTONOMY_OPTIONS.map((option) => {
              const checked = values.autonomy === option.value;
              return (
                <label
                  key={option.value}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-xl border bg-card px-4 py-3 transition-colors hover:bg-muted/40",
                    checked && "border-foreground/70 bg-muted/40 ring-[0.5px] ring-foreground/70",
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
      </div>

      {/* How they look: the avatar as it will show, with its color and emoji right under it. A
          teammate's page already has their name and job in its header, so only a new one repeats
          them here. */}
      <aside
        className="flex flex-col gap-6 rounded-2xl border bg-card p-5 lg:sticky lg:top-8 lg:self-start"
        data-testid="avatar-card"
      >
        <div className="flex flex-col items-center gap-3 pt-2 text-center">
          <BotAvatar
            name={values.name || "?"}
            color={values.color}
            emoji={values.emoji}
            size="xl"
          />
          {!editing && (
            <div className="flex flex-col gap-0.5">
              <span className="font-heading text-lg font-semibold">{values.name || "Unnamed"}</span>
              <span className="text-[13px] text-muted-foreground">
                {values.role || "No job yet"}
              </span>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2.5 border-t pt-5">
          <Label>Color</Label>
          <div
            className="flex flex-wrap justify-between gap-y-2"
            role="radiogroup"
            aria-label="Color"
          >
            {TEAMMATE_COLORS.map((color) => (
              <button
                type="button"
                key={color}
                role="radio"
                aria-checked={values.color === color}
                aria-label={color}
                onClick={() => set("color", color)}
                className="flex size-7 items-center justify-center rounded-full ring-offset-2 ring-offset-card transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                style={{
                  backgroundColor: color,
                  boxShadow:
                    values.color === color
                      ? `0 0 0 2px var(--card), 0 0 0 4px ${color}`
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
          <div className="flex items-center gap-3">
            <Input
              id="bot-emoji"
              value={values.emoji}
              onChange={(e) => set("emoji", lastGlyph(e.target.value))}
              aria-describedby="bot-emoji-hint"
              className="size-11 shrink-0 px-0 text-center text-[20px] md:text-[20px]"
            />
            <span id="bot-emoji-hint" className="text-[12.5px] leading-snug text-muted-foreground">
              {values.emoji ? (
                <button
                  type="button"
                  onClick={() => set("emoji", "")}
                  className="rounded-sm text-[13px] font-medium text-foreground/80 underline-offset-[3px] outline-none hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/12"
                >
                  Use initials instead
                </button>
              ) : (
                "Leave it empty for initials."
              )}
            </span>
          </div>
        </div>
      </aside>

      {/* Solid and flush with the bottom edge while there's something to save; once saved, it
          settles at the end of the form as a quiet line. It reaches 16px past the content on both
          sides, so what scrolls under it never shows an edge beside it, while its text stays on
          the content's edges. */}
      <div
        className={cn(
          "z-10 col-span-full -mx-4 -mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 bg-surface px-4",
          idle
            ? "-mb-4"
            : "sticky bottom-0 min-h-16 border-t pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]",
        )}
        data-testid="save-bar"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 text-[13.5px]" aria-live="polite">
          {!editing ? (
            missing ? (
              <span className="text-muted-foreground" data-testid="missing">
                {missing}
              </span>
            ) : (
              <span className="text-muted-foreground max-sm:hidden">
                You can change all of this later.
              </span>
            )
          ) : pending ? (
            <span className="text-muted-foreground">Saving…</span>
          ) : dirty ? (
            <>
              <span className="size-1.5 shrink-0 rounded-full bg-foreground" />
              <span className="font-medium">Unsaved changes</span>
            </>
          ) : justSaved ? (
            <>
              <CircleCheck className="size-4 shrink-0 text-done" />
              <span>Saved</span>
            </>
          ) : (
            <>
              <Check className="size-4 shrink-0 text-muted-foreground" />
              <span className="text-muted-foreground">All changes saved</span>
            </>
          )}
        </span>
        {(!editing || dirty || pending) && (
          <div className="flex items-center gap-2">
            {editing ? (
              <Button
                type="button"
                variant="ghost"
                size="lg"
                disabled={pending}
                onClick={() => setValues(baseline)}
              >
                Discard
              </Button>
            ) : (
              <Button type="button" variant="ghost" size="lg" onClick={() => router.back()}>
                Cancel
              </Button>
            )}
            <Button type="submit" size="lg" className="px-3.5" disabled={!canSubmit}>
              {pending && <Loader2 className="animate-spin" />}
              {submitLabel}
            </Button>
          </div>
        )}
      </div>
    </form>
  );
}
