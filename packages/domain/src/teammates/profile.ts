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

/**
 * Where a new teammate goes on the team: its name as a slug no teammate has, like `scout-2`, and
 * whether it leads, which the first one still on the team does. Decide it under the team lock
 * (`lockTeam` in `@open-bot/db`), so two at once can't both take it.
 */
export function newTeammateSlot(
  team: readonly { slug: string; archivedAt: Date | null }[],
  name: string,
): { slug: string; first: boolean } {
  const taken = new Set(team.map((teammate) => teammate.slug));
  const base = slugify(name);
  let slug = base;
  for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
  return { slug, first: !team.some((teammate) => !teammate.archivedAt) };
}

/** The longest the "About you" profile every teammate reads can be. */
export const MAX_ABOUT_ME_CHARS = 8000;

/** The longest a lesson from your feedback can be. */
export const MAX_LESSON_CHARS = 500;

/** How many of its newest lessons a teammate reads. */
export const MAX_LESSONS = 40;
