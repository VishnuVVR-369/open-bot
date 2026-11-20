"use client";

import { Sparkles } from "lucide-react";
import Link from "next/link";
import { BotAvatar } from "@/components/bot-avatar";
import type { BotSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { SkillOption } from "../skill-options";

/** The skills you can start with `/`, as you type their name. */
export function SkillMenu({
  options,
  members,
  selected,
  onHover,
  onPick,
}: {
  options: SkillOption[];
  members: BotSummary[];
  /** The option the arrow keys are on. */
  selected: number;
  onHover: (index: number) => void;
  onPick: (option: SkillOption) => void;
}) {
  return (
    <div
      className="absolute bottom-full left-0 mb-2 w-[min(420px,100%)] overflow-hidden rounded-xl border bg-popover p-1 shadow-lg"
      role="listbox"
      aria-label="Skills"
      data-testid="skill-menu"
    >
      <div className="flex items-center justify-between px-2 pt-1 pb-1.5 text-[12.5px] font-medium text-muted-foreground">
        Skills
        <Link
          href="/skills"
          onMouseDown={(event) => event.preventDefault()}
          className="text-[12px] font-normal tracking-normal normal-case hover:text-foreground"
        >
          Manage
        </Link>
      </div>
      {options.length === 0 ? (
        <p className="px-2 pb-2 text-[13px] text-muted-foreground">No skill matches that name.</p>
      ) : (
        options.map((skill, index) => {
          const owner = skill.teammateId ? members.find((m) => m.id === skill.teammateId) : null;
          return (
            <button
              key={skill.id}
              role="option"
              aria-selected={index === selected}
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(skill);
              }}
              onMouseEnter={() => onHover(index)}
              className={cn(
                "flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left",
                index === selected && "bg-muted",
              )}
            >
              <Sparkles className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-1.5">
                  <span className="font-mono text-[13px] font-medium">/{skill.name}</span>
                  {"builtIn" in skill && (
                    <span className="rounded bg-subtle px-1.5 text-[11px] leading-[18px] font-medium text-muted-foreground">
                      Built in
                    </span>
                  )}
                  {owner && (
                    <BotAvatar
                      name={owner.name}
                      color={owner.color}
                      emoji={owner.emoji}
                      size="xs"
                      className="scale-90"
                    />
                  )}
                </span>
                <span className="truncate text-[12.5px] text-muted-foreground">
                  {skill.description}
                </span>
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}
