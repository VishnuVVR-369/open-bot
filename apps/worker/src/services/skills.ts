import type { v2 } from "@open-bot/agent";
import { bots, skills } from "@open-bot/db";
import {
  COMPUTER_PATHS,
  invokedSkillNames,
  skillInputSchema,
  skillMarkdown,
  type SkillInput,
} from "@open-bot/shared";
import { and, eq, isNull, or } from "drizzle-orm";
import { publishApp, type Context } from "../context";

/** Skills every teammate can use. Codex reads this folder for every thread. */
const SHARED_ROOT = "/home/bot/.agents/skills";

/** Skills only one teammate can use, in its workspace. */
function botRoot(slug: string) {
  return `${COMPUTER_PATHS.workspace(slug)}/.agents/skills`;
}

type Skill = typeof skills.$inferSelect;
type BotRef = { id: string; slug: string };

export class SkillError extends Error {}

/**
 * Saved skills: the database is the source of truth, and each skill is written to the computer
 * as a Codex skill, so the model sees what it's for and can follow it when it fits.
 */
export class SkillService {
  constructor(private readonly ctx: Context) {}

  /** Skills a bot can use: the shared ones and its own. */
  async forBot(botId: string): Promise<Skill[]> {
    return this.ctx.db
      .select()
      .from(skills)
      .where(or(isNull(skills.botId), eq(skills.botId, botId)));
  }

  private async pathOf(skill: Skill): Promise<string> {
    if (!skill.botId) return `${SHARED_ROOT}/${skill.name}/SKILL.md`;
    const [bot] = await this.ctx.db
      .select({ slug: bots.slug })
      .from(bots)
      .where(eq(bots.id, skill.botId));
    return `${botRoot(bot!.slug)}/${skill.name}/SKILL.md`;
  }

  /** The skills a run's text invokes with `/name`, as Codex skill inputs. */
  async inputsFor(text: string, botId: string): Promise<v2.UserInput[]> {
    const names = invokedSkillNames(text);
    if (names.length === 0) return [];
    const available = await this.forBot(botId);
    const inputs: v2.UserInput[] = [];
    for (const name of names) {
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
    by: { kind: "user" } | { kind: "bot"; botId: string },
    id?: string,
  ): Promise<Skill> {
    const parsed = skillInputSchema.safeParse(input);
    if (!parsed.success) throw new SkillError(parsed.error.issues[0]!.message);
    const data = parsed.data;
    // You can move a skill between teammates; a teammate edits one only where it is.
    if (id && by.kind === "bot") {
      const [existing] = await this.ctx.db.select().from(skills).where(eq(skills.id, id));
      if (!existing || existing.botId !== data.botId)
        throw new SkillError(
          "That skill isn't in the selected scope. Get the teammate's skills first.",
        );
    }
    const visible = data.botId ? or(isNull(skills.botId), eq(skills.botId, data.botId)) : undefined;
    const clashes = await this.ctx.db
      .select({ id: skills.id, botId: skills.botId, createdByBotId: skills.createdByBotId })
      .from(skills)
      .where(and(eq(skills.name, data.name), visible));
    for (const clash of clashes) {
      if (clash.id === id) continue;
      // A bot saving a skill it wrote before in the same scope updates it; any other clash is an
      // error, so a teammate's skill never replaces a shared one or another teammate's.
      if (
        !id &&
        by.kind === "bot" &&
        clash.createdByBotId === by.botId &&
        clash.botId === data.botId
      ) {
        id = clash.id;
        continue;
      }
      throw new SkillError(
        clash.botId && clash.botId !== data.botId
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
          createdByBotId: by.kind === "bot" ? by.botId : null,
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
    const all = await this.ctx.db.select().from(skills);
    const botRows = await this.ctx.db
      .select({ id: bots.id, slug: bots.slug })
      .from(bots)
      .where(isNull(bots.archivedAt));
    await this.syncRoot(
      SHARED_ROOT,
      all.filter((s) => !s.botId),
    );
    for (const bot of botRows) await this.syncBot(bot, all);
    await this.refresh(botRows);
  }

  /** Write one bot's own skills, before it runs. */
  async syncBot(bot: BotRef, all?: Skill[]): Promise<void> {
    const rows = all ?? (await this.ctx.db.select().from(skills));
    await this.syncRoot(
      botRoot(bot.slug),
      rows.filter((s) => s.botId === bot.id),
    );
  }

  private async syncRoot(root: string, wanted: Skill[]) {
    const client = await this.ctx.codex.ready();
    await client.request("fs/createDirectory", { path: root, recursive: true });
    const { entries } = await client.request("fs/readDirectory", { path: root });
    const names = new Set(wanted.map((s) => s.name));
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
  }

  /** Have Codex read the skill folders again, so running threads see the change. */
  private async refresh(botRows: BotRef[]) {
    const client = await this.ctx.codex.ready();
    await client
      .request("skills/list", {
        cwds: botRows.map((bot) => COMPUTER_PATHS.workspace(bot.slug)),
        forceReload: true,
      })
      .catch(() => {});
  }
}
