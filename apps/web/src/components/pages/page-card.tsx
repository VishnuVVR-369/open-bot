"use client";

import type { PageItem } from "@open-bot/shared";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { PageThumbnail } from "./page-thumbnail";

export function pageHref(pageId: string, versionId?: string): string {
  return versionId ? `/pages/${pageId}?v=${versionId}` : `/pages/${pageId}`;
}

/** A page a teammate published in this turn. Opens the version it published. */
export function PageCard({ item }: { item: PageItem }) {
  return (
    <Link
      href={pageHref(item.pageId, item.versionId)}
      className="group/page flex w-full max-w-[560px] overflow-hidden rounded-xl bg-card shadow-raised transition-shadow hover:shadow-float focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      data-testid="page-card"
    >
      <PageThumbnail
        versionId={item.versionId}
        className="w-[38%] max-w-[200px] shrink-0 self-stretch after:shadow-none max-sm:hidden"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1 px-4 py-3 sm:border-l">
        <span className="text-[12.5px] font-medium text-muted-foreground">
          {item.version === 1 ? "New page" : `Page · version ${item.version}`}
        </span>
        <span className="line-clamp-2 font-heading text-[15px] leading-snug font-semibold">
          {item.title}
        </span>
        {item.summary && (
          <p className="line-clamp-2 text-[13px] leading-normal text-muted-foreground">
            {item.summary}
          </p>
        )}
        <span className="mt-auto flex items-center gap-1 pt-1.5 text-[13px] font-medium text-foreground/80 transition-colors group-hover/page:text-foreground">
          Open page
          <ArrowRight className="size-3.5 transition-transform group-hover/page:translate-x-0.5" />
        </span>
      </div>
    </Link>
  );
}
