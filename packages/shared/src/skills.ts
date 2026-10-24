import { z } from "zod";

/** Skill names are what you type after `/`, like `/weekly-report`. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const skillInputSchema = z.object({
  name: z
    .string()
    .min(2, "Give the skill a name of at least 2 characters")
    .max(48)
    .regex(SKILL_NAME_PATTERN, "Use lowercase letters, numbers and dashes, like weekly-report"),
  description: z.string().trim().min(1, "Say when to use the skill").max(300),
  instructions: z.string().trim().min(1, "Write the steps").max(20_000),
  /** The teammate who can use it, or null for every teammate. */
  botId: z.string().uuid().nullable(),
});

export type SkillInput = z.infer<typeof skillInputSchema>;

/** Turn a title like "Weekly report!" into a skill name like `weekly-report`. */
export function toSkillName(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
}

/** The skills a message invokes with `/name`. */
export function invokedSkillNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/(?:^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=$|[\s.,;:!?)])/g))
    names.add(match[1]!);
  return [...names];
}

/** A skill as Codex reads it: SKILL.md with its name and when to use it up front. */
export function skillMarkdown(skill: Pick<SkillInput, "name" | "description" | "instructions">) {
  // JSON strings are valid YAML double-quoted scalars, so any description is safe here.
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.instructions.trim()}\n`;
}
