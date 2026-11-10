"use client";

import { skipToken, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { orpc } from "@/lib/client/rpc";
import { cn } from "@/lib/utils";

/**
 * Which saved memories a reply was given, in a popover beside `children` (what it opens from,
 * like the reply's "More" button). Opened from the reply's More menu.
 */
export function RunMemory({
  runId,
  open,
  onOpenChange,
  children,
}: {
  runId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const { data, error } = useQuery(
    orpc.memory.forRun.queryOptions({ input: open ? { runId } : skipToken }),
  );
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
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
