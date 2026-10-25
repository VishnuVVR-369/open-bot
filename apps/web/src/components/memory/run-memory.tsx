"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getJson } from "@/lib/client/api";

interface Ref {
  id: string;
  revision: number;
  content: string | null;
  changed: boolean;
  forgotten: boolean;
}
export function RunMemory({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  const { data, error } = useQuery({
    queryKey: ["memory", "run", runId],
    queryFn: () => getJson<Ref[]>(`/api/memory?runId=${runId}`),
    enabled: open,
  });
  return (
    <div className="mt-2 text-xs text-muted-foreground">
      <button
        type="button"
        className="underline underline-offset-4"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Memory context
      </button>
      {open && (
        <div className="mt-2 rounded-lg border p-3">
          {error ? (
            "Couldn’t load memory references."
          ) : !data ? (
            "Loading…"
          ) : data.length === 0 ? (
            "No saved memories were supplied to this task."
          ) : (
            <ul className="flex flex-col gap-2">
              {data.map((ref) => (
                <li key={ref.id} className="break-words">
                  {ref.forgotten
                    ? "Forgotten memory"
                    : ref.changed
                      ? "Memory changed since this task"
                      : ref.content}
                  <span className="block font-mono text-[10px]">
                    {ref.id}@{ref.revision}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
