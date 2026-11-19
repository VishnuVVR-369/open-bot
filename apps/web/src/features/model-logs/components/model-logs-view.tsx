"use client";

import Link from "next/link";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { SettingsNav } from "@/features/settings";
import { RetentionTab } from "./retention-tab";
import { RunsTab } from "./runs-tab";
import { ToolsTab } from "./tools-tab";
import { UsageTab } from "./usage-tab";

export type ModelLogsTab = "runs" | "tools" | "usage" | "retention";

const TABS: { id: ModelLogsTab; label: string; href: string }[] = [
  { id: "runs", label: "Runs", href: "/settings/model-logs" },
  { id: "tools", label: "Tools", href: "/settings/model-logs/tools" },
  { id: "usage", label: "Usage", href: "/settings/model-logs/usage" },
  { id: "retention", label: "Retention", href: "/settings/model-logs/retention" },
];

/** The tabs, as links: each is a page of its own that keeps its filters in its address. */
function Tabs({ current }: { current: ModelLogsTab }) {
  return (
    <nav aria-label="Model logs" className="max-w-full overflow-x-auto">
      <ul className="inline-flex h-8 items-center rounded-lg bg-muted p-[3px] text-muted-foreground dark:bg-subtle">
        {TABS.map((tab) => (
          <li key={tab.id} className="h-full">
            <Link
              href={tab.href}
              aria-current={tab.id === current ? "page" : undefined}
              className={cn(
                "inline-flex h-full items-center rounded-md border border-transparent px-3 text-[13.5px] font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/12",
                tab.id === current
                  ? "bg-surface text-foreground shadow-raised dark:border-input dark:bg-input/40"
                  : "text-foreground/60 hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground",
              )}
              data-testid={`model-logs-tab-${tab.id}`}
            >
              {tab.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function TabContent({ tab }: { tab: ModelLogsTab }) {
  switch (tab) {
    case "runs":
      return <RunsTab />;
    case "tools":
      return <ToolsTab />;
    case "usage":
      return <UsageTab />;
    case "retention":
      return <RetentionTab />;
  }
}

/**
 * Settings, on its model logs pages: runs to search and open, tools and how they fail, usage
 * over time, and how long the logs keep their bodies.
 */
export function ModelLogsView({ tab = "runs" }: { tab?: ModelLogsTab }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8 md:grid-cols-[176px_minmax(0,1fr)] md:gap-12">
      <SettingsNav current="model-logs" />
      <section className="flex min-w-0 flex-col gap-5" data-testid="settings-model-logs">
        <div className="flex flex-col gap-1">
          <h2 className="text-[16px] font-semibold">Model logs</h2>
          <p className="max-w-[60ch] text-[13.5px] text-muted-foreground">
            Every request your teammates sent the model, run by run, with the tools they called and
            how each went. Only you can see them.
          </p>
        </div>
        <Tabs current={tab} />
        {/* The tabs read their filters from the address, which only the browser knows. */}
        <Suspense fallback={<Skeleton className="h-40 w-full rounded-xl" />}>
          <TabContent tab={tab} />
        </Suspense>
      </section>
    </div>
  );
}
