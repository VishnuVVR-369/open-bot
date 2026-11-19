"use client";

import { Bell, Brain, Plug, ScrollText, ShieldCheck, SunMoon, UserRound } from "lucide-react";
import Link from "next/link";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type GroupId =
  "account" | "memory" | "appearance" | "notifications" | "connections" | "security";

/** Settings in groups, one group at a time. Old links to a section (#email) open its group. */
export const GROUPS: { id: GroupId; label: string; icon: typeof UserRound; sections: string[] }[] =
  [
    {
      id: "account",
      label: "Account",
      icon: UserRound,
      sections: ["chatgpt", "plan", "usage", "timezone"],
    },
    { id: "memory", label: "Memory", icon: Brain, sections: ["about"] },
    { id: "appearance", label: "Appearance", icon: SunMoon, sections: [] },
    { id: "notifications", label: "Notifications", icon: Bell, sections: ["telegram"] },
    { id: "connections", label: "Connections", icon: Plug, sections: ["email", "browsing"] },
    {
      id: "security",
      label: "Security",
      icon: ShieldCheck,
      sections: ["password", "set-password", "passkeys"],
    },
  ];

const LINK =
  "flex h-9 items-center gap-2.5 rounded-lg px-3 text-[14px] whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/12";
// A quiet gray fill marks where you are; on the white page a raised white surface didn't show.
const ACTIVE = "bg-muted font-medium text-foreground";
const IDLE = "text-muted-foreground hover:bg-subtle hover:text-foreground";

/** How wide the fade is at an edge the list runs past. */
const FADE = "64px";

/** Which edges of a row that scrolls sideways have more past them. */
type Edges = { start: boolean; end: boolean };

function edgesOf(list: HTMLElement): Edges {
  const end = list.scrollWidth - list.clientWidth;
  return { start: list.scrollLeft > 1, end: list.scrollLeft < end - 1 };
}

/** Fades out the edges with more past them, so a row that scrolls sideways says so. */
function fadeStyle({ start, end }: Edges): CSSProperties | undefined {
  if (!start && !end) return undefined;
  const mask = `linear-gradient(to right, ${start ? "transparent" : "black"}, black ${FADE}, black calc(100% - ${FADE}), ${end ? "transparent" : "black"})`;
  return { maskImage: mask, WebkitMaskImage: mask };
}

/**
 * Settings' groups, then the pages of their own under Settings (model logs). A group is a link to
 * `/settings#group`, so it works from those pages too, and on Settings changes only the hash. On a
 * phone the list is one row that scrolls sideways: it opens with the current item in view, and
 * fades out at an edge with more past it.
 */
export function SettingsNav({ current }: { current: GroupId | "model-logs" }) {
  const list = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState<Edges>({ start: false, end: false });

  useEffect(() => {
    const row = list.current;
    if (!row) return;
    const active = row.querySelector<HTMLElement>('[aria-current="page"]');
    if (active && row.scrollWidth > row.clientWidth) {
      // Centered when it can be; scrolling only the row, never the page.
      const left = active.offsetLeft - (row.clientWidth - active.offsetWidth) / 2;
      row.scrollLeft = Math.max(0, Math.min(left, row.scrollWidth - row.clientWidth));
    }
    const update = () =>
      setEdges((seen) => {
        const next = edgesOf(row);
        return next.start === seen.start && next.end === seen.end ? seen : next;
      });
    update();
    row.addEventListener("scroll", update, { passive: true });
    const resized = new ResizeObserver(update);
    resized.observe(row);
    return () => {
      row.removeEventListener("scroll", update);
      resized.disconnect();
    };
  }, [current]);

  return (
    <nav aria-label="Settings" className="md:sticky md:top-0 md:self-start">
      <ul
        ref={list}
        data-overflow={
          [edges.start && "start", edges.end && "end"].filter(Boolean).join(" ") || undefined
        }
        style={fadeStyle(edges)}
        className="-mx-5 flex gap-1 overflow-x-auto px-5 [scrollbar-width:none] md:mx-0 md:flex-col md:gap-0.5 md:px-0"
      >
        {GROUPS.map((group) => {
          const Icon = group.icon;
          const active = group.id === current;
          return (
            <li key={group.id} className="shrink-0">
              <a
                href={`/settings#${group.id}`}
                aria-current={active ? "page" : undefined}
                className={cn(LINK, active ? ACTIVE : IDLE)}
              >
                <Icon className="size-4 shrink-0" />
                {group.label}
              </a>
            </li>
          );
        })}
        <li className="shrink-0 md:mt-3 md:border-t md:pt-3">
          <Link
            href="/settings/model-logs"
            aria-current={current === "model-logs" ? "page" : undefined}
            className={cn(LINK, current === "model-logs" ? ACTIVE : IDLE)}
          >
            <ScrollText className="size-4 shrink-0" />
            Model logs
          </Link>
        </li>
      </ul>
    </nav>
  );
}
