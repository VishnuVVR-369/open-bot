/** How much a bot may do without asking. */
export type Autonomy = "full" | "risky" | "everything";

export const AUTONOMY_OPTIONS: { value: Autonomy; label: string; description: string }[] = [
  {
    value: "full",
    label: "Works on its own",
    description:
      "Doesn't stop to ask. Payments over its budget and deleting important data still need your approval.",
  },
  {
    value: "risky",
    label: "Asks before risky actions",
    description:
      "Asks before sending, publishing, buying, deleting or changing settings on your behalf.",
  },
  {
    value: "everything",
    label: "Asks before every command",
    description: "Asks before each shell command and file change. Slow, but you see everything.",
  },
];

/** A curated palette for bot avatars. Each bot gets one as its accent color. */
export const BOT_COLORS = [
  "#7C5CFF",
  "#2E9BFF",
  "#14B8A6",
  "#22C55E",
  "#EAB308",
  "#F97316",
  "#EF4444",
  "#EC4899",
] as const;

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "bot"
  );
}

/** The longest the "About you" profile every teammate reads can be. */
export const MAX_ABOUT_ME_CHARS = 8000;

/** The longest a lesson from your feedback can be. */
export const MAX_LESSON_CHARS = 500;

/** How many of its newest lessons a teammate reads. */
export const MAX_LESSONS = 40;
