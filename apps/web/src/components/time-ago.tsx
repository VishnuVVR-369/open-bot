"use client";

import { relativeTime } from "@open-bot/shared";
import { useEffect, useState } from "react";

/**
 * "4h ago", kept current, in the short form the phone app uses too. The server and the browser
 * render it a moment apart, so the first paint may differ; that's expected rather than a
 * hydration error. Hovering shows the exact time.
 */
export function TimeAgo({ date, className }: { date: string; className?: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((value) => value + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <time
      dateTime={date}
      title={new Date(date).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
      className={className}
      suppressHydrationWarning
    >
      {relativeTime(date)}
    </time>
  );
}
