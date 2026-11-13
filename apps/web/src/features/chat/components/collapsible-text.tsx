"use client";

import { ChevronDown } from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { cn } from "@/lib/utils";

/** Lines a long message shows until you open it. */
const COLLAPSED_LINES = 8;
/** A message folds only when that hides at least this many more lines, so it never hides just one. */
const MIN_HIDDEN_LINES = 4;
/** The last lines fade out, so it reads as cut rather than ended. A mask works on any bubble color. */
const FOLDED: CSSProperties = {
  maxHeight: `${COLLAPSED_LINES}lh`,
  maskImage: "linear-gradient(to bottom, black calc(100% - 2.5lh), transparent)",
};

/**
 * Text that folds to its first few lines when it's long, fading out above a "Show more" toggle.
 * `watch` is the text itself, so the fold is measured again when it changes.
 */
export function CollapsibleText({
  children,
  watch,
  className,
}: {
  children: ReactNode;
  watch: string;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  const id = useId();

  // Measured before paint, so a long message never flashes open first. Width changes reflow the
  // text, so a narrower window can fold a message that fit before.
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => {
      const line = parseFloat(getComputedStyle(element).lineHeight) || 24;
      setLong(element.scrollHeight > line * (COLLAPSED_LINES + MIN_HIDDEN_LINES));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [watch]);

  const folded = long && !open;
  return (
    <div ref={box} className={cn("flex flex-col", className)}>
      <div
        ref={content}
        id={id}
        className={cn(folded && "overflow-hidden")}
        style={folded ? FOLDED : undefined}
        data-testid="message-body"
        data-folded={folded || undefined}
      >
        {children}
      </div>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => {
            // Folding a message you scrolled down through would leave you far below it.
            flushSync(() => setOpen(!open));
            if (open) box.current?.scrollIntoView({ block: "nearest" });
          }}
          className="-mx-1 mt-1 inline-flex items-center gap-1 self-start rounded-md px-1 text-[13px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/12"
          data-testid="message-toggle"
        >
          {open ? "Show less" : "Show more"}
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        </button>
      )}
    </div>
  );
}
