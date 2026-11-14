"use client";

import { useQuery } from "@tanstack/react-query";
import { useAppState } from "@/features/app-shell";
import { orpc } from "@/lib/client/rpc";
import { compactNumber } from "@/lib/utils";
import { SectionState } from "./section-state";

export function UsageSection() {
  const { data: state } = useAppState();
  const usage = useQuery(orpc.settings.usage.queryOptions());
  if (!usage.data) return <SectionState error={usage.error} onRetry={() => void usage.refetch()} />;
  if (!usage.data.length)
    return <p className="text-[14px] text-muted-foreground">No work yet this month.</p>;
  const total = usage.data.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <table className="w-full text-[13.5px]">
        <thead className="bg-subtle/60 text-left text-[12px] text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">Teammate</th>
            <th className="px-4 py-2 text-right font-medium">Runs</th>
            <th className="px-4 py-2 text-right font-medium">Input</th>
            <th className="px-4 py-2 text-right font-medium">Cached</th>
            <th className="px-4 py-2 text-right font-medium">Output</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {usage.data.map((row) => {
            const bot = state?.bots.find((b) => b.id === row.botId);
            return (
              <tr key={row.botId ?? "none"}>
                <td className="px-4 py-2">{bot?.name ?? "Archived teammate"}</td>
                <td className="px-4 py-2 text-right tabular-nums">{row.runs}</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {compactNumber(row.inputTokens)}
                </td>
                <td className="px-4 py-2 text-right text-muted-foreground tabular-nums">
                  {compactNumber(row.cachedInputTokens)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {compactNumber(row.outputTokens)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="border-t px-4 py-2 text-[12.5px] text-muted-foreground">
        {compactNumber(total)} tokens this month. API key spend is under When your plan runs out.
      </p>
    </div>
  );
}
