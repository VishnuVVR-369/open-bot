import { cn } from "@/lib/utils";

/** `paused`: they have work, but it waits for the computer to come back. */
export type BotActivity = "idle" | "working" | "waiting" | "queued" | "paused";

const SIZES = {
  xs: "size-5 rounded-[6px] text-[10px]",
  sm: "size-7 rounded-[8px] text-[12px]",
  md: "size-9 rounded-[10px] text-[14px]",
  lg: "size-12 rounded-[13px] text-[18px]",
  xl: "size-16 rounded-[17px] text-[24px]",
} as const;

/**
 * Emoji at about 58% of the tile, the size they read at on the phone. Initials stay smaller:
 * letters fill their box, emoji leave air around the drawing.
 */
const EMOJI_SIZES = {
  xs: "text-[12px]",
  sm: "text-[16px]",
  md: "text-[21px]",
  lg: "text-[28px]",
  xl: "text-[37px]",
} as const;

function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return (words[0] ?? "?").slice(0, 1).toUpperCase();
}

/**
 * A teammate's tile: their color, their emoji or initials, and a status light.
 * The light follows the status signals in globals.css: blue while working, amber when they need you,
 * gray while queued or paused for an offline computer, and nothing at all while idle.
 */
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
          backgroundImage: `linear-gradient(180deg, color-mix(in oklab, ${color} 22%, var(--surface)), color-mix(in oklab, ${color} 12%, var(--surface)))`,
          color: `color-mix(in oklab, ${color} 80%, var(--foreground))`,
          boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 26%, transparent), inset 0 1px 0 color-mix(in oklab, white 35%, transparent)`,
        }}
      >
        {emoji ? (
          // A line box of exactly the glyph's size, so flexbox centers the drawing, not its text line.
          <span className={cn("block leading-[1] font-normal", EMOJI_SIZES[size])}>{emoji}</span>
        ) : (
          initials(name)
        )}
      </span>
      {activity !== "idle" && (
        <span
          className={cn(
            "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-(--avatar-ring)",
            activity === "working" && "animate-tally bg-working",
            activity === "waiting" && "bg-attention",
            (activity === "queued" || activity === "paused") && "bg-idle",
          )}
        />
      )}
    </span>
  );
}
