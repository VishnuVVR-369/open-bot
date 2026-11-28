import { z } from "zod";

/** How much a teammate may do without asking. */
export const AUTONOMY_LEVELS = ["full", "risky", "everything"] as const;
export const autonomySchema = z.enum(AUTONOMY_LEVELS);
export type Autonomy = (typeof AUTONOMY_LEVELS)[number];

/** Who made a schedule, trigger, skill or task: you, or a teammate. */
export const CREATORS = ["user", "teammate"] as const;
export const creatorSchema = z.enum(CREATORS);
export type Creator = (typeof CREATORS)[number];

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

/** A curated palette for teammate avatars. Each teammate gets one as its accent color. */
export const TEAMMATE_COLORS = [
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
      .slice(0, 40) || "teammate"
  );
}

/**
 * Where a new teammate goes on the team: its name as a slug no teammate has, like `scout-2`, and
 * whether it leads, which the first one still on the team does. Decide it under the team lock
 * (`LOCKS.team` in `@open-bot/db`), so two at once can't both take it.
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

/**
 * The color a new teammate gets: the one the team uses least, earliest in the palette on a tie,
 * so teammates created in a row don't all look the same.
 */
export function nextTeammateColor(usedColors: readonly string[]): string {
  const uses = (color: string) => usedColors.filter((used) => used === color).length;
  return TEAMMATE_COLORS.reduce((best, color) => (uses(color) < uses(best) ? color : best));
}

/** The longest the "About you" profile every teammate reads can be. */
export const MAX_ABOUT_ME_CHARS = 8000;

/** The longest a lesson from your feedback can be. */
export const MAX_LESSON_CHARS = 500;

/** How many of its newest lessons a teammate reads. */
export const MAX_LESSONS = 40;

/**
 * A name for a copy of a teammate: "Iris 2", or the next number no teammate uses yet. A name
 * that already ends in a number counts on from its base ("Iris 2" copies as "Iris 3").
 */
export function copyName(name: string, taken: readonly string[]): string {
  const base = name.trim().replace(/\s+\d+$/, "");
  const used = new Set(taken.map((entry) => entry.trim().toLowerCase()));
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * The last whole character of what was typed: one emoji, even one built from several code points
 * (a flag, a skin tone, a family joined with zero-width joiners). Where the runtime has no
 * `Intl.Segmenter` (Hermes on the phone), a pattern for emoji sequences stands in.
 */
export function lastGlyph(text: string): string {
  if (typeof Intl.Segmenter === "function") {
    const glyphs = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)];
    return glyphs.at(-1)?.segment ?? "";
  }
  return lastGlyphByPattern(text);
}

const LAST_GLYPH =
  /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}[\uFE0F\p{Emoji_Modifier}\u{E0020}-\u{E007F}]*(?:\u200D\p{Extended_Pictographic}[\uFE0F\p{Emoji_Modifier}]*)*|[^\p{M}]\p{M}*|\p{M}+)$/u;

/** `lastGlyph` without `Intl.Segmenter`; exported for its tests. */
export function lastGlyphByPattern(text: string): string {
  return LAST_GLYPH.exec(text)?.[0] ?? "";
}
