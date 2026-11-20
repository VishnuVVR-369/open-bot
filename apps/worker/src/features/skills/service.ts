import type { v2 } from "@open-bot/agent";
import { teammates, skills, type Queryable } from "@open-bot/db";
import {
  PAGE_SKILL_DESCRIPTION,
  PAGE_SKILL_MARKDOWN,
  PAGE_SKILL_NAME,
  PAGE_TEMPLATE_HTML,
} from "@open-bot/page-kit/skill";
import {
  COMPUTER_PATHS,
  invokedSkillNames,
  isBuiltInSkill,
  skillInputSchema,
  skillMarkdown,
  type SkillInput,
} from "@open-bot/domain";
import { and, eq, isNull, or } from "drizzle-orm";
import { publishApp, type Context } from "../../context";
import { WorkerError } from "../../core/errors";
import { errorMessage } from "../../logger";

/** Skills every teammate can use. Codex reads this folder for every thread. */
const SHARED_ROOT = "/home/bot/.agents/skills";

/** Skills only one teammate can use, in its workspace. */
function teammateRoot(slug: string) {
  return `${COMPUTER_PATHS.workspace(slug)}/.agents/skills`;
}

/** Skills open-bot gives every teammate, with the files that go in each skill's folder. */
const BUILT_IN_SKILLS: { name: string; files: Record<string, string> }[] = [
  {
    name: PAGE_SKILL_NAME,
    files: {
      "SKILL.md": skillMarkdown({
        name: PAGE_SKILL_NAME,
        description: PAGE_SKILL_DESCRIPTION,
        instructions: PAGE_SKILL_MARKDOWN,
      }),
      "template.html": PAGE_TEMPLATE_HTML,
    },
  },
];

type Skill = typeof skills.$inferSelect;
type TeammateRef = { id: string; slug: string };

export class SkillError extends WorkerError {
  constructor(message: string) {
    super(400, message);
  }
}

/**
 * Saved skills: the database is the source of truth, and each skill is written to the computer
 * as a Codex skill, so the model sees what it's for and can follow it when it fits.
 */
export class SkillService {
  constructor(private readonly ctx: Context) {}

  /** Skills a teammate can use: the shared ones and its own. */
  async forTeammate(teammateId: string): Promise<Skill[]> {
    return this.ctx.db
      .select()
      .from(skills)
      .where(or(isNull(skills.teammateId), eq(skills.teammateId, teammateId)));
  }

  private async pathOf(skill: Skill): Promise<string> {
    if (!skill.teammateId) return `${SHARED_ROOT}/${skill.name}/SKILL.md`;
    const [teammate] = await this.ctx.db
      .select({ slug: teammates.slug })
      .from(teammates)
      .where(eq(teammates.id, skill.teammateId));
    return `${teammateRoot(teammate!.slug)}/${skill.name}/SKILL.md`;
  }

  /** The skills a run's text invokes with `/name`, as Codex skill inputs. */
  async inputsFor(text: string, teammateId: string): Promise<v2.UserInput[]> {
    const names = invokedSkillNames(text);
    if (names.length === 0) return [];
    const available = await this.forTeammate(teammateId);
    const inputs: v2.UserInput[] = [];
    for (const name of names) {
      if (isBuiltInSkill(name)) {
        inputs.push({ type: "skill", name, path: `${SHARED_ROOT}/${name}/SKILL.md` });
        continue;
      }
      const skill = available.find((s) => s.name === name);
      if (skill) inputs.push({ type: "skill", name: skill.name, path: await this.pathOf(skill) });
    }
    return inputs;
  }

  /**
   * Create or update a skill. A name is unique among the skills a teammate can use, so a shared
   * skill's name is taken for everyone, and a teammate's own skill only for that teammate.
   */
  async save(
    input: SkillInput,
    by: { kind: "user" } | { kind: "bot"; teammateId: string },
    id?: string,
  ): Promise<Skill> {
    const parsed = skillInputSchema.safeParse(input);
    if (!parsed.success) throw new SkillError(parsed.error.issues[0]!.message);
    const data = parsed.data;
    // You can move a skill between teammates; a teammate edits one only where it is.
    if (id && by.kind === "bot") {
      const [existing] = await this.ctx.db.select().from(skills).where(eq(skills.id, id));
      if (!existing || existing.teammateId !== data.teammateId)
        throw new SkillError(
          "That skill isn't in the selected scope. Get the teammate's skills first.",
        );
    }
    const visible = data.teammateId
      ? or(isNull(skills.teammateId), eq(skills.teammateId, data.teammateId))
      : undefined;
    const clashes = await this.ctx.db
      .select({
        id: skills.id,
        teammateId: skills.teammateId,
        createdByTeammateId: skills.createdByTeammateId,
      })
      .from(skills)
      .where(and(eq(skills.name, data.name), visible));
    for (const clash of clashes) {
      if (clash.id === id) continue;
      // A teammate saving a skill it wrote before in the same scope updates it; any other clash is an
      // error, so a teammate's skill never replaces a shared one or another teammate's.
      if (
        !id &&
        by.kind === "bot" &&
        clash.createdByTeammateId === by.teammateId &&
        clash.teammateId === data.teammateId
      ) {
        id = clash.id;
        continue;
      }
      throw new SkillError(
        clash.teammateId && clash.teammateId !== data.teammateId
          ? `Another teammate has its own /${data.name} skill. Pick another name, or make this one just for one teammate.`
          : `A skill named /${data.name} already exists. Pick another name.`,
      );
    }
    let row: Skill | undefined;
    if (id) {
      [row] = await this.ctx.db.update(skills).set(data).where(eq(skills.id, id)).returning();
      if (!row) throw new SkillError("That skill no longer exists");
    } else {
      [row] = await this.ctx.db
        .insert(skills)
        .values({
          ...data,
          createdBy: by.kind,
          createdByTeammateId: by.kind === "bot" ? by.teammateId : null,
        })
        .returning();
    }
    await this.syncAll();
    await publishApp(this.ctx, { type: "skills" });
    return row!;
  }

  async remove(id: string): Promise<void> {
    await this.ctx.db.delete(skills).where(eq(skills.id, id));
    await this.syncAll();
    await publishApp(this.ctx, { type: "skills" });
  }

  /** Write every skill to the computer and remove the ones that were deleted. */
  async syncAll(): Promise<void> {
    if (this.ctx.lifecycle?.resting && !this.ctx.lifecycle.inScope) return;
    const all = await this.ctx.db.select().from(skills);
    const teammateRows = await this.ctx.db
      .select({ id: teammates.id, slug: teammates.slug })
      .from(teammates)
      .where(isNull(teammates.archivedAt));
    await this.syncRoot(
      SHARED_ROOT,
      all.filter((s) => !s.teammateId && !isBuiltInSkill(s.name)),
      BUILT_IN_SKILLS,
    );
    for (const teammate of teammateRows) await this.syncTeammate(teammate, all);
    await this.refresh(teammateRows);
  }

  /** Write one teammate's own skills, before it runs. */
  async syncTeammate(teammate: TeammateRef, all?: Skill[]): Promise<void> {
    const rows = all ?? (await this.ctx.db.select().from(skills));
    await this.syncRoot(
      teammateRoot(teammate.slug),
      rows.filter((s) => s.teammateId === teammate.id),
    );
  }

  private async syncRoot(
    root: string,
    wanted: Skill[],
    builtIns: { name: string; files: Record<string, string> }[] = [],
  ) {
    const client = await this.ctx.codex.ready();
    await client.request("fs/createDirectory", { path: root, recursive: true });
    const { entries } = await client.request("fs/readDirectory", { path: root });
    const names = new Set([...wanted.map((s) => s.name), ...builtIns.map((s) => s.name)]);
    for (const entry of entries) {
      if (entry.isDirectory && !names.has(entry.fileName))
        await client.request("fs/remove", { path: `${root}/${entry.fileName}`, recursive: true });
    }
    for (const skill of wanted) {
      await client.request("fs/createDirectory", {
        path: `${root}/${skill.name}`,
        recursive: true,
      });
      await client.request("fs/writeFile", {
        path: `${root}/${skill.name}/SKILL.md`,
        dataBase64: Buffer.from(skillMarkdown(skill)).toString("base64"),
      });
    }
    for (const skill of builtIns) {
      await client.request("fs/createDirectory", {
        path: `${root}/${skill.name}`,
        recursive: true,
      });
      for (const [file, content] of Object.entries(skill.files))
        await client.request("fs/writeFile", {
          path: `${root}/${skill.name}/${file}`,
          dataBase64: Buffer.from(content).toString("base64"),
        });
    }
  }

  /** Have Codex read the skill folders again, so running threads see the change. */
  private async refresh(teammateRows: TeammateRef[]) {
    const client = await this.ctx.codex.ready();
    await client
      .request("skills/list", {
        cwds: teammateRows.map((teammate) => COMPUTER_PATHS.workspace(teammate.slug)),
        forceReload: true,
      })
      .catch((error: unknown) =>
        this.ctx.log.warn("couldn't reload skills in Codex", { error: errorMessage(error) }),
      );
  }
}

/** Gives a new teammate its own copies of these skills, in the caller's transaction. */
export async function addTeammateSkills(
  tx: Queryable,
  teammateId: string,
  list: readonly { name: string; description: string; instructions: string }[],
): Promise<void> {
  if (list.length === 0) return;
  await tx
    .insert(skills)
    .values(list.map((skill) => ({ ...skill, teammateId, createdBy: "user" as const })));
}
