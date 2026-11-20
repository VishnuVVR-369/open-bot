"use client";

import { TeammateAvatar } from "@/components/teammate-avatar";
import type { TeammateSummary } from "@/lib/types";

const STARTERS = [
  "Open news.ycombinator.com and give me the 5 most interesting stories, with links.",
  "Every weekday at 9:00, check the weather in my city and send me a one-line summary.",
  "Remember that I prefer short answers with bullet points.",
];

export function EmptyState({
  members,
  onPick,
  isGroup,
}: {
  members: TeammateSummary[];
  onPick: (text: string) => void;
  isGroup: boolean;
}) {
  const teammate = members[0];
  return (
    <div className="m-auto flex w-full max-w-[560px] flex-col items-center gap-6 px-6 py-16 text-center">
      {isGroup ? (
        <div className="flex -space-x-2">
          {members.map((member) => (
            <TeammateAvatar
              key={member.id}
              name={member.name}
              color={member.color}
              emoji={member.emoji}
              size="lg"
              className="rounded-[14px] ring-4 ring-surface"
            />
          ))}
        </div>
      ) : (
        teammate && (
          <TeammateAvatar
            name={teammate.name}
            color={teammate.color}
            emoji={teammate.emoji}
            size="xl"
          />
        )
      )}
      <div className="flex flex-col gap-1.5">
        <h2 className="text-xl font-semibold">
          {isGroup ? "Start the conversation" : `Give ${teammate?.name ?? "them"} something to do`}
        </h2>
        <p className="text-[14px] text-muted-foreground">
          {isGroup
            ? "Your message goes to the lead teammate, or to whoever you @mention. They pass work to each other."
            : `${teammate?.name ?? "Your teammate"} works on the shared computer. Watch on the right, and take over whenever you want.`}
        </p>
      </div>
      <div className="flex w-full flex-col gap-2">
        {STARTERS.map((starter) => (
          <button
            key={starter}
            onClick={() => onPick(starter)}
            className="rounded-xl bg-card px-4 py-3 text-left text-[13.5px] text-foreground/85 shadow-raised transition-shadow hover:shadow-float"
          >
            {starter}
          </button>
        ))}
      </div>
    </div>
  );
}
