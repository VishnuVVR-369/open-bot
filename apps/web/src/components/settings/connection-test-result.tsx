"use client";

import { Check, TriangleAlert } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ConnectionTestView } from "@/lib/types";

/** What testing a connection found: its tools, or what went wrong. */
export function TestResult({
  result,
  summary = "Connected",
}: {
  result: ConnectionTestView;
  /** What a working connection says first, like "Signed in as you@gmail.com". */
  summary?: string;
}) {
  if (!result.ok)
    return (
      <p
        className="flex items-start gap-2 rounded-lg bg-destructive/8 px-3 py-2 text-[13px] text-destructive"
        data-testid="connection-test"
      >
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        {result.error ?? "It didn't connect."}
      </p>
    );
  return (
    <div
      className="flex flex-col gap-1.5 rounded-lg bg-done/8 px-3 py-2 text-[13px]"
      data-testid="connection-test"
    >
      <span className="flex items-center gap-2 font-medium text-done">
        <Check className="size-3.5" />
        {summary} · {result.tools.length} {result.tools.length === 1 ? "tool" : "tools"}
      </span>
      {result.tools.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 pl-5.5">
          {result.tools.slice(0, 24).map((tool) => (
            <Tooltip key={tool.name}>
              <TooltipTrigger asChild>
                <li className="rounded bg-card px-1.5 py-0.5 font-mono text-[11.5px] text-foreground/80 ring-1 ring-border">
                  {tool.name}
                </li>
              </TooltipTrigger>
              {tool.description && (
                <TooltipContent className="max-w-72">{tool.description}</TooltipContent>
              )}
            </Tooltip>
          ))}
          {result.tools.length > 24 && (
            <li className="text-[12px] text-muted-foreground">+{result.tools.length - 24} more</li>
          )}
        </ul>
      )}
    </div>
  );
}
