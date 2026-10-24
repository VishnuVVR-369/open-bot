"use client";

import type { RuleKind } from "@open-bot/shared";
import { FilePen, MousePointerClick, SquareTerminal, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { removeApprovalRule } from "@/lib/actions";

export interface AllowedRule {
  id: string;
  kind: RuleKind;
  pattern: string;
}

const ICONS = { command: SquareTerminal, file_change: FilePen, action: MousePointerClick };

function RuleText({ rule }: { rule: AllowedRule }) {
  switch (rule.kind) {
    case "file_change":
      return <span>Changing files in their workspace</span>;
    case "command":
      return (
        <span>
          Commands starting with{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12.5px]">
            {rule.pattern}
          </code>
        </span>
      );
    case "action":
      return <span>{rule.pattern}</span>;
  }
}

/** What a teammate may do without asking, from "Always allow" on an approval. */
export function AllowedRules({ name, rules }: { name: string; rules: AllowedRule[] }) {
  const router = useRouter();
  const [removing, setRemoving] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function remove(rule: AllowedRule) {
    setRemoving(rule.id);
    startTransition(async () => {
      const result = await removeApprovalRule(rule.id);
      if (!result.ok) toast.error(result.error);
      else toast(`${name} will ask again`, { description: "From their next message." });
      router.refresh();
      setRemoving(null);
    });
  }

  return (
    <section className="flex flex-col gap-4 border-t pt-8" data-testid="allowed-rules">
      <div className="flex flex-col gap-0.5">
        <span className="text-[14px] font-medium">Always allowed</span>
        <span className="text-[13px] text-muted-foreground">
          {rules.length > 0
            ? `${name} does these without asking you first.`
            : `Nothing yet. Pick "Always allow" when you approve something and ${name} stops asking about it.`}
        </span>
      </div>
      {rules.length > 0 && (
        <ul className="flex flex-col divide-y rounded-xl border bg-card">
          {rules.map((rule) => {
            const Icon = ICONS[rule.kind];
            return (
              <li
                key={rule.id}
                className="flex min-h-12 items-center gap-3 py-1.5 pr-2 pl-4 text-[13.5px]"
                data-testid="allowed-rule"
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 break-words">
                  <RuleText rule={rule} />
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Ask me again"
                      disabled={removing === rule.id}
                      onClick={() => remove(rule)}
                    >
                      <X />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Ask me again</TooltipContent>
                </Tooltip>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
