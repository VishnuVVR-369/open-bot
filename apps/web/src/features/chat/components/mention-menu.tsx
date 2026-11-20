"use client";

import { TeammateAvatar } from "@/components/teammate-avatar";
import type { TeammateSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

/** The teammates you can @mention in a group, as you type their name. */
export function MentionMenu({
  options,
  selected,
  onHover,
  onPick,
}: {
  options: TeammateSummary[];
  /** The option the arrow keys are on. */
  selected: number;
  onHover: (index: number) => void;
  onPick: (option: TeammateSummary) => void;
}) {
  return (
    <div
      className="absolute bottom-full left-0 mb-2 w-64 overflow-hidden rounded-xl border bg-popover p-1 shadow-lg"
      role="listbox"
      aria-label="Teammates"
    >
      {options.map((member, index) => (
        <button
          key={member.id}
          role="option"
          aria-selected={index === selected}
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(member);
          }}
          onMouseEnter={() => onHover(index)}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left",
            index === selected && "bg-muted",
          )}
        >
          <TeammateAvatar name={member.name} color={member.color} emoji={member.emoji} size="xs" />
          <span className="text-sm font-medium">{member.name}</span>
          <span className="truncate text-xs text-muted-foreground">{member.role}</span>
        </button>
      ))}
    </div>
  );
}
