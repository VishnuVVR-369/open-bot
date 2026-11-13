"use client";

import { elapsed, workingText } from "@open-bot/chat-core";
import { useEffect, useState } from "react";
import type { RunView } from "@/lib/types";
import { cn } from "@/lib/utils";

function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="font-mono text-[12px] tabular-nums">
      {elapsed(now - new Date(since).getTime())}
    </span>
  );
}

export function WorkingLine({ run }: { run: RunView }) {
  const { status } = run.timeline;
  // The approval or takeover card above already says what the run needs from you.
  if (status === "waiting") return null;
  // A running turn's steps show right above, so the line doesn't repeat the latest one.
  return (
    <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <span
        className={cn(
          "size-2 rounded-full",
          status === "queued" ? "bg-idle" : "animate-tally bg-working",
        )}
      />
      <span>{workingText(run, { activity: false })}</span>
      {status !== "queued" && <Elapsed since={run.createdAt} />}
    </div>
  );
}
