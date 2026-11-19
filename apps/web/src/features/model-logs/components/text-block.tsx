"use client";

import { Check, Copy } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { formatSize } from "../format";

/** How much of a long text shows before "Show all". */
const PREVIEW_CHARS = 1_200;
const PREVIEW_LINES = 14;
/** How much of a JSON body shows before "Show all": past this it is slow to lay out. */
const JSON_PREVIEW_CHARS = 60_000;

/** The start of a text: at most so many characters and lines. */
function preview(text: string, chars: number, lines: number): string {
  let cut = Math.min(text.length, chars);
  let at = -1;
  for (let i = 0; i < lines; i++) {
    at = text.indexOf("\n", at + 1);
    if (at < 0 || at >= cut) break;
    if (i === lines - 1) cut = at;
  }
  return text.slice(0, cut);
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-subtle hover:text-foreground"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : label}
    </button>
  );
}

/**
 * Text as text, never as HTML: its start, then all of it on request. Long lines wrap inside the
 * box, so nothing pushes the page sideways, and code or output scrolls in its own box.
 */
export function ClampedText({
  text,
  mono = false,
  chars,
  rest,
  className,
}: {
  text: string;
  mono?: boolean;
  /** Its full length, when `text` is already only the start of it. */
  chars?: number;
  /** Where the rest of a cut text can be read. */
  rest?: string;
  className?: string;
}) {
  const [all, setAll] = useState(false);
  const start = preview(text, PREVIEW_CHARS, PREVIEW_LINES);
  const cut = !all && start.length < text.length;
  const more = chars !== undefined && chars > text.length ? chars - text.length : 0;
  if (!text) return <p className="text-[13px] text-muted-foreground italic">Empty</p>;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <div
        className={cn(
          "min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]",
          // Code and output sit in a box of their own that scrolls once it is long.
          mono
            ? "max-h-[24rem] overflow-y-auto rounded-lg border bg-subtle/50 px-3 py-2 font-mono text-[12.5px] leading-relaxed"
            : "text-[13.5px] leading-relaxed",
        )}
      >
        {cut ? `${start}…` : text}
      </div>
      {(cut || all) && (
        <button
          type="button"
          onClick={() => setAll((value) => !value)}
          className="self-start text-[12.5px] font-medium text-muted-foreground hover:text-foreground"
        >
          {all
            ? "Show less"
            : more
              ? `Show the first ${formatSize(text.length)}`
              : `Show all, ${formatSize(text.length)}`}
        </button>
      )}
      {more > 0 && (
        <p className="text-[12px] text-muted-foreground">
          {formatSize(more)} more not shown here.{rest ? ` ${rest}` : ""}
        </p>
      )}
    </div>
  );
}

/** JSON laid out in a box of its own that scrolls, with a copy button. */
export function JsonBlock({
  json,
  label,
  className,
}: {
  json: string;
  label?: string;
  className?: string;
}) {
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      return json;
    }
  }, [json]);
  const [all, setAll] = useState(false);
  const cut = !all && pretty.length > JSON_PREVIEW_CHARS;
  return (
    <div className={cn("min-w-0 overflow-hidden rounded-lg border bg-subtle/50", className)}>
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1">
        <span className="text-[12px] text-muted-foreground">
          {label ?? "JSON"} · {formatSize(json.length)}
        </span>
        <CopyButton text={pretty} />
      </div>
      <pre className="max-h-[28rem] overflow-auto p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
        {cut ? `${pretty.slice(0, JSON_PREVIEW_CHARS)}…` : pretty}
      </pre>
      {cut && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="w-full border-t px-3 py-1.5 text-left text-[12.5px] font-medium text-muted-foreground hover:text-foreground"
        >
          Show all, {formatSize(pretty.length)}
        </button>
      )}
    </div>
  );
}
