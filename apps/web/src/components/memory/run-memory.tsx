"use client";

import { useQuery } from "@tanstack/react-query";
import { Brain } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getJson } from "@/lib/client/api";
import { cn, REVEAL_ON_RUN_HOVER } from "@/lib/utils";

interface Ref {
  id: string;
  revision: number;
  content: string | null;
  changed: boolean;
  forgotten: boolean;
}

/** Which saved memories a reply was given. Sits with the reply's other actions in its header. */
export function RunMemory({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  const { data, error } = useQuery({
    queryKey: ["memory", "run", runId],
    queryFn: () => getJson<Ref[]>(`/api/memory?runId=${runId}`),
    enabled: open,
  });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Memory context"
              className={cn(
                "text-muted-foreground",
                open ? "text-foreground" : REVEAL_ON_RUN_HOVER,
              )}
            >
              <Brain />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>What they remembered</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-[min(26rem,calc(100vw-2rem))] gap-0 p-0">
        <div className="border-b px-3.5 py-2.5 text-[12.5px] font-medium text-muted-foreground">
          Memories given to this reply
        </div>
        <div className="max-h-80 overflow-y-auto px-3.5 py-3 text-[13px]">
          {error ? (
            <p className="text-muted-foreground">Couldn’t load memory references.</p>
          ) : !data ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : data.length === 0 ? (
            <p className="text-muted-foreground">No saved memories were given to this reply.</p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {data.map((ref) => (
                <li key={`${ref.id}@${ref.revision}`} className="break-words">
                  <span
                    className={cn((ref.forgotten || ref.changed) && "text-muted-foreground italic")}
                  >
                    {ref.forgotten
                      ? "Forgotten memory"
                      : ref.changed
                        ? "Memory changed since this task"
                        : ref.content}
                  </span>
                  <span className="mt-0.5 block font-mono text-[10.5px] text-faint">
                    {ref.id}@{ref.revision}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
