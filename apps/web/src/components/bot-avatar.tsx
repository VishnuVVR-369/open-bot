import { cn } from "@/lib/utils";

export type BotActivity = "idle" | "working" | "waiting" | "queued";

const SIZES = {
  xs: "size-5 rounded-[6px] text-[10px]",
  sm: "size-7 rounded-[8px] text-[12px]",
  md: "size-9 rounded-[10px] text-[14px]",
  lg: "size-12 rounded-[13px] text-[18px]",
  xl: "size-16 rounded-[17px] text-[24px]",
} as const;

function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return (words[0] ?? "?").slice(0, 1).toUpperCase();
}

/** A teammate's tile: their color, their emoji or initials, and a status light. */
export function BotAvatar({
  name,
  color,
  emoji,
  size = "md",
  activity = "idle",
  className,
}: {
  name: string;
  color: string;
  emoji?: string;
  size?: keyof typeof SIZES;
  activity?: BotActivity;
  className?: string;
}) {
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <span
        aria-hidden
        className={cn(
          "flex items-center justify-center font-heading font-semibold select-none",
          SIZES[size],
        )}
        style={{
          backgroundColor: `color-mix(in oklab, ${color} 16%, var(--surface))`,
          color: `color-mix(in oklab, ${color} 78%, var(--foreground))`,
          boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 30%, transparent)`,
        }}
      >
        {emoji ? <span className="leading-none">{emoji}</span> : initials(name)}
      </span>
      {activity !== "idle" && (
        <span
          className={cn(
            "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-sidebar",
            activity === "working" && "animate-tally bg-live",
            activity === "waiting" && "bg-waiting",
            activity === "queued" && "bg-muted-foreground/60",
          )}
        />
      )}
    </span>
  );
}
