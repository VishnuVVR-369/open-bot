import { BUILT_IN_SKILLS } from "@open-bot/domain";
import type { SkillSummary } from "@/lib/types";

/** A skill the menu offers: one you saved, or one that comes with the app. */
export type SkillOption =
  SkillSummary | { id: string; name: string; description: string; botId: null; builtIn: true };

/** The name typed after a `/` that ends at the caret (`""` right after the slash), or null. */
export function skillQueryAt(value: string, caret: number): string | null {
  const skill = /(^|\s)\/([a-z0-9-]*)$/.exec(value.slice(0, caret));
  return skill ? skill[2]! : null;
}

/**
 * Skills this chat's teammates can use: the built-in ones, the shared ones and their own. Those
 * whose name contains `query` are offered, names starting with it first, at most eight.
 */
export function skillOptions(
  query: string,
  members: readonly { id: string }[],
  skills: readonly SkillSummary[],
): SkillOption[] {
  const memberIds = new Set(members.map((member) => member.id));
  const usable: SkillOption[] = [
    ...BUILT_IN_SKILLS.map((skill) => ({
      id: `built-in:${skill.name}`,
      name: skill.name,
      description: skill.description,
      botId: null,
      builtIn: true as const,
    })),
    ...skills.filter((skill) => skill.botId === null || memberIds.has(skill.botId)),
  ];
  const lower = query.toLowerCase();
  return usable
    .filter((skill) => skill.name.includes(lower))
    .sort((a, b) => Number(!a.name.startsWith(lower)) - Number(!b.name.startsWith(lower)))
    .slice(0, 8);
}
