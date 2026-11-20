"use client";

import { formatDistanceToNowStrict } from "date-fns";
import { CalendarClock, CalendarDays, Eye, Mail, Webhook } from "lucide-react";
import Link from "next/link";
import { PageThumbnail, usePages } from "@/features/pages";
import { useAppState } from "@/features/app-shell";
import type { ActivityView } from "@/lib/types";
import { SideHeading } from "./side-heading";

/** The latest pages your teammates published, as pictures you can open. */
export function RecentPages() {
  const { data: state } = useAppState();
  const { data: pages } = usePages();
  const latest = [...(pages ?? [])]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 2);
  if (!state || latest.length === 0) return null;
  return (
    <section className="flex flex-col gap-3" aria-label="Recent pages" data-testid="recent-pages">
      <SideHeading title="Recent pages" href="/pages" label="All pages" />
      <div className="grid grid-cols-2 gap-3">
        {latest.map((page) => {
          const teammate = state.teammates.find((entry) => entry.id === page.teammateId);
          return (
            <Link
              key={page.id}
              href={`/pages/${page.id}`}
              className="group flex min-w-0 flex-col overflow-hidden rounded-xl bg-card shadow-raised transition-shadow hover:shadow-float"
            >
              <PageThumbnail versionId={page.versionId} />
              {/* A title may take two lines; the byline sits at the bottom, level with its neighbor's. */}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2.5">
                <span className="line-clamp-2 text-[13.5px] leading-snug font-medium text-pretty group-hover:underline">
                  {page.title}
                </span>
                <span className="mt-auto truncate text-[12.5px] text-muted-foreground">
                  {teammate?.name ?? "Former teammate"} ·{" "}
                  {formatDistanceToNowStrict(new Date(page.updatedAt), { addSuffix: true })}
                </span>
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

/** A small mark for a run an automation started, before its outcome. */
export const ACTIVITY_TRIGGER_ICONS: Partial<
  Record<ActivityView["trigger"], typeof CalendarClock>
> = {
  schedule: CalendarClock,
  watch: Eye,
  webhook: Webhook,
  gmail: Mail,
  calendar: CalendarDays,
};
