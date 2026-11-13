"use client";

import { ArrowRight, Sparkles } from "lucide-react";
import Link from "next/link";
import { useAppState } from "@/lib/client/queries";

/**
 * A teammate's suggested new instructions: worth a look when you have a minute, so a quiet row
 * outside "Needs you", and not in its count.
 */
export function Suggestions() {
  const { data: state } = useAppState();
  const proposals = (state?.proposals ?? []).flatMap((proposal) => {
    const teammate = state?.bots.find((entry) => entry.id === proposal.botId);
    return teammate ? [{ ...proposal, teammate }] : [];
  });
  if (proposals.length === 0) return null;
  return (
    <div className="flex flex-col">
      {proposals.map((proposal) => (
        <Link
          key={proposal.id}
          href={`/bots/${proposal.teammate.id}`}
          className="group flex items-center gap-3 rounded-xl px-4 py-2.5 text-[13.5px] transition-colors hover:bg-subtle"
          data-testid="proposal-link"
        >
          <Sparkles className="size-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0 rounded-full bg-subtle px-2 py-px text-[11.5px] font-medium text-muted-foreground group-hover:bg-muted">
            Suggestion
          </span>
          <span className="min-w-0 flex-1 text-pretty">
            {proposal.teammate.name} suggests new instructions
          </span>
          <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
        </Link>
      ))}
    </div>
  );
}
