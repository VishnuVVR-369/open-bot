"use client";

import { formatDistanceToNowStrict } from "date-fns";
import { useEffect, useState } from "react";

/**
 * "3 minutes ago", kept current. The server and the browser render it a moment apart, so the
 * first paint may differ by a second; that's expected rather than a hydration error.
 */
export function TimeAgo({ date, className }: { date: string; className?: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((value) => value + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <time dateTime={date} className={className} suppressHydrationWarning>
      {formatDistanceToNowStrict(new Date(date), { addSuffix: true })}
    </time>
  );
}
