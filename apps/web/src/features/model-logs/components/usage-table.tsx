"use client";

import { cacheShare, compactNumber, type UsageNumbers } from "@open-bot/domain";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { formatCost } from "../format";

type Row = UsageNumbers & { key: string; name: string };

const NUMBER = "px-3 py-2 text-right tabular-nums whitespace-nowrap";

/**
 * Usage numbers as a table: per teammate, per model, or per day, which is also the charts' table
 * view. Wide columns drop out on a phone; the table scrolls inside its box past that.
 */
export function UsageTable({
  title,
  rows,
  mono = false,
  collapsed = false,
}: {
  title: string;
  rows: Row[];
  mono?: boolean;
  /** Closed until asked for, for the long table behind the charts. */
  collapsed?: boolean;
}) {
  const [open, setOpen] = useState(!collapsed);
  return (
    <section className="flex min-w-0 flex-col gap-2" data-testid="usage-table">
      {collapsed ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex items-center gap-1 self-start text-[13px] font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className={cn("size-4 transition-transform", !open && "-rotate-90")} />
          {title}, as a table
        </button>
      ) : (
        <h3 className="text-[14px] font-semibold">{title}</h3>
      )}
      {open && (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="w-full text-[13px]">
            <thead className="bg-subtle/60 text-[12px] text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">{collapsed ? "When" : "Name"}</th>
                <th className="px-3 py-2 text-right font-medium">Requests</th>
                <th className="px-3 py-2 text-right font-medium">Input</th>
                <th className="px-3 py-2 text-right font-medium">Cached</th>
                <th className="px-3 py-2 text-right font-medium">Output</th>
                <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Reasoning</th>
                <th className="px-3 py-2 text-right font-medium">Cost</th>
                <th className="px-3 py-2 text-right font-medium">Failed</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row) => {
                const share = cacheShare(row);
                return (
                  <tr key={row.key}>
                    <td
                      className={cn(
                        "max-w-[220px] truncate px-3 py-2",
                        mono && "font-mono text-[12.5px]",
                      )}
                    >
                      {row.name}
                    </td>
                    <td className={NUMBER}>{row.requests.toLocaleString("en-US")}</td>
                    <td className={NUMBER}>{compactNumber(row.inputTokens)}</td>
                    <td className={cn(NUMBER, "text-muted-foreground")}>
                      {share === null ? "-" : `${Math.round(share * 100)}%`}
                    </td>
                    <td className={NUMBER}>{compactNumber(row.outputTokens)}</td>
                    <td className={cn(NUMBER, "hidden text-muted-foreground sm:table-cell")}>
                      {compactNumber(row.reasoningTokens)}
                    </td>
                    <td className={NUMBER}>
                      {row.costMicros > 0 ? formatCost(row.costMicros) : "-"}
                    </td>
                    <td
                      className={cn(
                        NUMBER,
                        row.errors > 0 ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {row.errors}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
