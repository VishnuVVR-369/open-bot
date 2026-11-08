"use client";

import { RECOVERY_COPY } from "@open-bot/domain";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A command to run in a terminal, in a code face, with a Copy button that says when it worked.
 * It stays on one line and scrolls sideways when it's long, so it never breaks mid-command.
 */
export function CopyCommand({ command, className }: { command: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-lg border bg-subtle py-1 pr-1 pl-3",
        className,
      )}
    >
      <code
        className="min-w-0 flex-1 overflow-x-auto py-1 font-mono text-[12.5px] leading-relaxed whitespace-nowrap [scrollbar-width:thin]"
        data-testid="command"
        tabIndex={0}
      >
        {command}
      </code>
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard.writeText(command);
          setCopied(true);
        }}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border bg-card px-2.5 text-[12.5px] font-medium text-foreground transition-colors outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/12"
        aria-label={copied ? RECOVERY_COPY.copied : `Copy ${command}`}
      >
        {copied ? <Check className="size-3.5 text-done" /> : <Copy className="size-3.5" />}
        {copied ? RECOVERY_COPY.copied : RECOVERY_COPY.copyAction}
      </button>
    </div>
  );
}
