import { cn } from "@/lib/utils";

/** The open-bot mark: a small screen with its tally light on. */
export function Logo({ className, live = true }: { className?: string; live?: boolean }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("size-7", className)}>
      <rect width="32" height="32" rx="8" className="fill-foreground" />
      <rect
        x="6.5"
        y="8.5"
        width="19"
        height="12.5"
        rx="2"
        className="fill-none stroke-background"
        strokeWidth="2"
      />
      <circle cx="22.5" cy="11.5" r="1.5" className={live ? "fill-live" : "fill-background"} />
      <path d="M12.5 24.5h7" className="stroke-background" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <Logo />
      <span className="font-heading text-[17px] font-semibold tracking-tight">open-bot</span>
    </span>
  );
}
