"use client";

import { lineDiff } from "@open-bot/shared";
import { Loader2, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useTransition } from "react";
import { toast } from "sonner";
import { TimeAgo } from "@/components/time-ago";
import { Button } from "@/components/ui/button";
import { acceptProposal, dismissProposal } from "@/lib/actions";
import type { ProposalView } from "@/lib/types";
import { cn } from "@/lib/utils";

/** A teammate's suggested instructions, as a change you can accept or dismiss. */
export function InstructionsProposal({
  proposal,
  name,
  instructionsNow,
}: {
  proposal: ProposalView;
  name: string;
  /** The instructions as they are now, which may have changed since the suggestion. */
  instructionsNow: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [accepting, startAccepting] = useTransition();
  const lines = useMemo(
    () => lineDiff(instructionsNow, proposal.proposed),
    [instructionsNow, proposal.proposed],
  );
  const editedSince = instructionsNow !== proposal.current;

  return (
    <section
      className="flex flex-col gap-4 rounded-xl border border-waiting/35 bg-waiting/[0.04] p-4"
      aria-label="Suggested instructions"
      data-testid="instructions-proposal"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-waiting/12 text-waiting">
          <Sparkles className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[14px] font-medium">
            {name} suggests new instructions
            <span className="font-normal text-muted-foreground">
              {" "}
              · <TimeAgo date={proposal.createdAt} />
            </span>
          </span>
          <span className="text-[13.5px] text-muted-foreground">{proposal.reason}</span>
          {editedSince && (
            <span className="text-[12.5px] text-muted-foreground">
              You changed the instructions since. Accepting replaces them with the suggestion.
            </span>
          )}
        </div>
      </div>
      <pre
        className="max-h-80 overflow-auto rounded-lg border bg-card py-2 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap"
        data-testid="proposal-diff"
      >
        {lines.map((line, index) => (
          <div
            key={index}
            className={cn(
              "flex gap-2 px-3",
              line.type === "added" && "bg-done/10 text-done",
              line.type === "removed" &&
                "bg-destructive/8 text-destructive line-through decoration-destructive/40",
            )}
          >
            <span className="w-3 shrink-0 select-none text-muted-foreground" aria-hidden>
              {line.type === "added" ? "+" : line.type === "removed" ? "−" : ""}
            </span>
            <span className="min-w-0 flex-1">{line.text || " "}</span>
          </div>
        ))}
      </pre>
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          disabled={pending || accepting}
          onClick={() =>
            startTransition(async () => {
              const result = await dismissProposal(proposal.id);
              if (!result.ok) toast.error(result.error);
              router.refresh();
            })
          }
        >
          Dismiss
        </Button>
        <Button
          disabled={pending || accepting}
          onClick={() =>
            startAccepting(async () => {
              const result = await acceptProposal(proposal.id);
              if (!result.ok) {
                toast.error("Couldn't apply it", { description: result.error });
                return;
              }
              toast(`${name} has new instructions`, {
                description: "They apply from the next message.",
              });
              router.refresh();
            })
          }
        >
          {accepting && <Loader2 className="animate-spin" />}
          Accept
        </Button>
      </div>
    </section>
  );
}
