"use client";

import { toSkillName } from "@open-bot/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Users } from "lucide-react";
import { useEffect, useState, useTransition, type ReactNode } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { saveSkill } from "@/lib/actions";
import { queryKeys, useAppState } from "@/lib/client/queries";
import type { SkillView } from "@/lib/types";

const EVERYONE = "everyone";

const INSTRUCTIONS_PLACEHOLDER = `## Goal
Send me a short summary of last week's sales every Monday.

## Steps
1. Open the sales dashboard and filter to last week.
2. Note the total, the change from the week before, and the top 3 products.
3. Check the numbers add up before writing anything.

## Output
Five bullet points, with the dashboard link at the end.

## If something fails
Tell me what blocked you instead of guessing.`;

/** Create a skill, or edit one when `skill` is given. */
export function SkillDialog({
  skill,
  trigger,
  defaultBotId,
}: {
  skill?: SkillView;
  trigger?: ReactNode;
  defaultBotId?: string;
}) {
  const { data: state } = useAppState();
  const bots = state?.bots ?? [];
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [owner, setOwner] = useState(EVERYONE);
  const [pending, startTransition] = useTransition();
  const queryClient = useQueryClient();

  // Start from the skill (or a blank one) each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setName(skill?.name ?? "");
    setDescription(skill?.description ?? "");
    setInstructions(skill?.instructions ?? "");
    setOwner(skill ? (skill.botId ?? EVERYONE) : (defaultBotId ?? EVERYONE));
  }, [open, skill, defaultBotId]);

  const canSave = name.length >= 2 && description.trim() && instructions.trim() && !pending;

  function submit() {
    startTransition(async () => {
      const result = await saveSkill({
        id: skill?.id ?? null,
        name,
        description: description.trim(),
        instructions: instructions.trim(),
        botId: owner === EVERYONE ? null : owner,
      });
      if (!result.ok) {
        toast.error("Couldn't save the skill", { description: result.error });
        return;
      }
      toast(skill ? "Skill updated" : "Skill saved", {
        description: `Type /${name} in a chat to run it.`,
      });
      setOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.skills }),
        queryClient.invalidateQueries({ queryKey: queryKeys.state }),
      ]);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button data-testid="new-skill">
            <Plus />
            New skill
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{skill ? `Edit /${skill.name}` : "New skill"}</DialogTitle>
          <DialogDescription>
            Write the steps once. Teammates follow them whenever you type the skill&apos;s name
            after /, or when a request fits what it&apos;s for.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) submit();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="skill-name">Name</Label>
              <div className="flex h-9 items-center rounded-md border bg-transparent shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30">
                <span className="pl-3 font-mono text-[14px] text-muted-foreground">/</span>
                <input
                  id="skill-name"
                  value={name}
                  onChange={(event) => {
                    // Typing a space or a capital letter still gives a valid name.
                    const raw = event.target.value;
                    const trailing = /[\s-]$/.test(raw) ? "-" : "";
                    setName((toSkillName(raw) + trailing).replace(/^-/, "").slice(0, 48));
                  }}
                  onBlur={() => setName((value) => value.replace(/-+$/, ""))}
                  placeholder="weekly-report"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-full min-w-0 flex-1 bg-transparent pr-3 pl-0.5 font-mono text-[14px] outline-none placeholder:text-muted-foreground/70"
                  data-testid="skill-name"
                />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label>Who can use it</Label>
              <Select value={owner} onValueChange={setOwner}>
                <SelectTrigger className="w-full" data-testid="skill-owner">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={EVERYONE}>
                    <Users className="size-4" />
                    Every teammate
                  </SelectItem>
                  {bots.map((bot) => (
                    <SelectItem key={bot.id} value={bot.id}>
                      <BotAvatar name={bot.name} color={bot.color} emoji={bot.emoji} size="xs" />
                      Only {bot.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="skill-description">When to use it</Label>
            <Input
              id="skill-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Summarize last week's sales from the dashboard"
              maxLength={300}
              data-testid="skill-description"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="skill-instructions">Instructions</Label>
            <Textarea
              id="skill-instructions"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder={INSTRUCTIONS_PLACEHOLDER}
              className="max-h-[50vh] min-h-64 font-mono text-[13px] leading-relaxed"
              data-testid="skill-instructions"
            />
            <p className="text-[12.5px] text-muted-foreground">
              Markdown. Good skills say where to look, the steps, what to check before finishing,
              the output and what to do when something fails.
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave} data-testid="save-skill">
              {pending && <Loader2 className="animate-spin" />}
              {skill ? "Save changes" : "Save skill"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
