"use client";

import { useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import { Pencil, Sparkles, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { BotAvatar } from "@/components/bot-avatar";
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
import { deleteSkill } from "@/lib/actions";
import { queryKeys, useAppState, useSkills } from "@/lib/client/queries";
import type { SkillView } from "@/lib/types";
import { SkillDialog } from "./skill-dialog";

function DeleteSkill({ skill }: { skill: SkillView }) {
  const queryClient = useQueryClient();
  return (
    <AlertDialog>
      <Tooltip>
        <TooltipTrigger asChild>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Delete /${skill.name}`}>
              <Trash2 />
            </Button>
          </AlertDialogTrigger>
        </TooltipTrigger>
        <TooltipContent>Delete</TooltipContent>
      </Tooltip>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete /{skill.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Teammates stop using it right away. This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={async () => {
              const result = await deleteSkill(skill.id);
              if (!result.ok) toast.error(result.error);
              await Promise.all([
                queryClient.invalidateQueries({ queryKey: queryKeys.skills }),
                queryClient.invalidateQueries({ queryKey: queryKeys.state }),
              ]);
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Every saved skill, or the ones one teammate can use. */
export function SkillsList({ botId }: { botId?: string }) {
  const { data, isLoading } = useSkills();
  const { data: state } = useAppState();
  const skills = (data ?? []).filter(
    (skill) => !botId || skill.botId === null || skill.botId === botId,
  );
  const botOf = (id: string | null) => state?.bots.find((bot) => bot.id === id);

  if (isLoading) {
    return (
      <div className="grid gap-3 md:grid-cols-2">
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-32 rounded-xl" />
      </div>
    );
  }

  if (skills.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed px-6 py-14 text-center">
        <Sparkles className="size-6 text-muted-foreground" />
        <p className="font-medium">No skills yet</p>
        <p className="max-w-md text-[13.5px] text-muted-foreground">
          Save the steps for a task once, then run it any time by typing / in a chat. Teammates can
          save skills too: after a task goes well, ask &ldquo;save that as a skill&rdquo;.
        </p>
        {botId && (
          <div className="mt-2">
            <SkillDialog defaultBotId={botId} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {botId && (
        <div className="flex justify-end">
          <SkillDialog defaultBotId={botId} />
        </div>
      )}
      <ul className="grid gap-3 md:grid-cols-2">
        {skills.map((skill) => {
          const owner = botOf(skill.botId);
          const author = skill.createdBy === "bot" ? botOf(skill.createdByBotId) : null;
          return (
            <li
              key={skill.id}
              className="group relative flex flex-col gap-3 rounded-xl border bg-card p-4 transition-colors hover:border-foreground/20"
              data-testid="skill"
            >
              <div className="flex items-start gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-subtle text-muted-foreground">
                  <Sparkles className="size-4" />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate pr-14 font-mono text-[14px] font-medium">
                    /{skill.name}
                  </span>
                  <p className="line-clamp-2 text-[13.5px] text-muted-foreground">
                    {skill.description}
                  </p>
                </div>
                <div className="absolute top-2.5 right-2.5 flex rounded-lg bg-card opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
                  <SkillDialog
                    skill={skill}
                    trigger={
                      <Button variant="ghost" size="icon-sm" aria-label={`Edit /${skill.name}`}>
                        <Pencil />
                      </Button>
                    }
                  />
                  <DeleteSkill skill={skill} />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-12 text-[12.5px] text-muted-foreground">
                {owner ? (
                  <span className="flex items-center gap-1.5">
                    <BotAvatar
                      name={owner.name}
                      color={owner.color}
                      emoji={owner.emoji}
                      size="xs"
                    />
                    Only {owner.name}
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5">
                    <Users className="size-3.5" />
                    Every teammate
                  </span>
                )}
                <span>
                  {author ? `Saved by ${author.name}` : "Saved by you"}{" "}
                  {formatDistanceToNowStrict(new Date(skill.updatedAt), { addSuffix: true })}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
