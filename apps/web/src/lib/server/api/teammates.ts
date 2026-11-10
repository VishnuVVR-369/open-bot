import "server-only";
import type { ApiInputs, ApiOutputs } from "@open-bot/api";
import {
  bots as teammates,
  CHANNELS,
  chats,
  lockTeammateCreation,
  notify,
  runs,
  schedules,
  settings,
  triggers,
  type Tx,
} from "@open-bot/db";
import { slugify, teammateBundleSchema } from "@open-bot/domain";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, pool } from "../db";
import { memoryReady } from "../memory";
import { publish } from "../publish";
import { nextTeammateColor } from "../queries";
import { insertTeammateParts, teammateParts } from "../teammates";
import { worker } from "../worker";
import { ApiError } from "./errors";

type Inputs = ApiInputs["teammates"];
type Outputs = ApiOutputs["teammates"];

/**
 * Where a new teammate goes: its name as a URL slug no other teammate has, like `scout-2`, and
 * whether it leads, which the first one does. Held under the lock every creation takes, the
 * worker's too, until the transaction ends.
 */
async function newTeammateSlot(tx: Tx, name: string): Promise<{ slug: string; first: boolean }> {
  await lockTeammateCreation(tx);
  const rows = await tx
    .select({ slug: teammates.slug, archivedAt: teammates.archivedAt })
    .from(teammates);
  const taken = new Set(rows.map((row) => row.slug));
  const base = slugify(name);
  let slug = base;
  for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
  return { slug, first: !rows.some((row) => !row.archivedAt) };
}

/** A step after the change is saved: if it fails, the change still happened, so it's logged. */
async function afterSaving(step: string, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    console.warn(`teammate saved, but ${step} failed`, error);
  }
}

async function ownerTimeZone(): Promise<string> {
  const [row] = await db
    .select({ timezone: settings.timezone })
    .from(settings)
    .where(eq(settings.id, 1));
  return row?.timezone ?? "UTC";
}

/** Write the teammate's workspace now; before its next run is soon enough if the computer's away. */
export async function syncWorkspace(teammateId: string) {
  await afterSaving("importing its legacy memory", async () =>
    (await memoryReady()).importLegacy(),
  );
  await worker.teammates.sync({ teammateId }).catch(() => {});
}

/** What changing who's on the team refreshes. */
async function publishTeamChanged() {
  await Promise.all([
    publish({ type: "bots" }),
    publish({ type: "skills" }),
    publish({ type: "schedules" }),
    publish({ type: "triggers" }),
    publish({ type: "lessons" }),
  ]);
}

export async function createTeammate({
  profile,
  templateId,
  starterIds,
}: Inputs["create"]): Promise<Outputs["create"]> {
  return worker.teammates.create({
    ...profile,
    template_id: templateId ?? undefined,
    starter_ids: starterIds,
  });
}

export async function updateTeammate({
  teammateId,
  profile,
  revision,
}: Inputs["update"]): Promise<Outputs["update"]> {
  return worker.teammates.update({ teammateId, changes: profile, expected_revision: revision });
}

export async function duplicateTeammate({
  teammateId,
  name,
  copyMemory,
}: Inputs["duplicate"]): Promise<Outputs["duplicate"]> {
  const [source] = await db
    .select()
    .from(teammates)
    .where(and(eq(teammates.id, teammateId), isNull(teammates.archivedAt)));
  if (!source) throw new ApiError("NOT_FOUND", "That teammate no longer exists.");
  const parts = await teammateParts(teammateId);
  const timezone = await ownerTimeZone();

  const created = await db.transaction(async (tx) => {
    const { slug } = await newTeammateSlot(tx, name);
    const [copy] = await tx
      .insert(teammates)
      .values({
        name,
        slug,
        role: source.role,
        instructions: source.instructions,
        color: source.color,
        emoji: source.emoji,
        autonomy: source.autonomy,
        isPrimary: false,
      })
      .returning({ id: teammates.id });
    const [chat] = await tx
      .insert(chats)
      .values({ kind: "direct", title: name, botId: copy!.id })
      .returning({ id: chats.id });
    await insertTeammateParts(
      tx,
      copy!.id,
      // Lessons are learned, like memory, so they come along with it.
      { ...parts, lessons: copyMemory ? parts.lessons : [] },
      timezone,
    );
    // Reminders still to come are copied too, paused like the rest.
    const reminders = await tx
      .select()
      .from(schedules)
      .where(and(eq(schedules.botId, teammateId), eq(schedules.kind, "once")));
    const upcoming = reminders.filter((reminder) => (reminder.runAt?.getTime() ?? 0) > Date.now());
    if (upcoming.length > 0)
      await tx.insert(schedules).values(
        upcoming.map((reminder) => ({
          botId: copy!.id,
          title: reminder.title,
          prompt: reminder.prompt,
          kind: "once" as const,
          runAt: reminder.runAt,
          nextRunAt: reminder.runAt,
          timezone: reminder.timezone,
          enabled: false,
          createdBy: "user" as const,
        })),
      );
    return { teammateId: copy!.id, chatId: chat!.id };
  });

  await syncWorkspace(created.teammateId);
  let memoryCopied = !copyMemory;
  if (copyMemory)
    memoryCopied = await (
      await memoryReady()
    )
      .copyBot(source.id, created.teammateId)
      .then(() => true)
      .catch(() => false);
  await publishTeamChanged();
  return { ...created, memoryCopied };
}

/** The first thing wrong with an exported file, in words. */
function bundleProblem(file: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(file);
  } catch {
    return "This isn't an open-bot teammate file.";
  }
  const parsed = teammateBundleSchema.safeParse(json);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  return issue?.path.length
    ? `The file has a problem at ${issue.path.join(".")}: ${issue.message}`
    : (issue?.message ?? "The file couldn't be read.");
}

export async function importTeammate({ file }: Inputs["import"]): Promise<Outputs["import"]> {
  const problem = bundleProblem(file);
  if (problem) throw new ApiError("BAD_REQUEST", problem);
  const { teammate, ...parts } = teammateBundleSchema.parse(JSON.parse(file));
  const color = teammate.color ?? (await nextTeammateColor());
  const timezone = await ownerTimeZone();

  const created = await db.transaction(async (tx) => {
    const { slug, first } = await newTeammateSlot(tx, teammate.name);
    const [row] = await tx
      .insert(teammates)
      .values({
        name: teammate.name,
        slug,
        role: teammate.role,
        instructions: teammate.instructions,
        color,
        emoji: teammate.emoji,
        autonomy: teammate.autonomy,
        // The first teammate leads.
        isPrimary: first,
      })
      .returning({ id: teammates.id });
    const [chat] = await tx
      .insert(chats)
      .values({ kind: "direct", title: teammate.name, botId: row!.id })
      .returning({ id: chats.id });
    await insertTeammateParts(tx, row!.id, parts, timezone);
    return { teammateId: row!.id, chatId: chat!.id };
  });
  await syncWorkspace(created.teammateId);
  await publishTeamChanged();
  return {
    ...created,
    name: teammate.name,
    paused: parts.routines.length + parts.watches.length,
  };
}

export async function setLead({ teammateId }: Inputs["setLead"]): Promise<{ ok: true }> {
  await db.transaction(async (tx) => {
    // One statement over every teammate, so two at once queue on the same rows in the same order
    // instead of deadlocking, and the later one sees the earlier one's lead.
    const rows = await tx
      .update(teammates)
      .set({
        isPrimary: sql`(${teammates.id} = ${teammateId} and ${teammates.archivedAt} is null)`,
      })
      .returning({ lead: teammates.isPrimary });
    if (!rows.some((row) => row.lead))
      throw new ApiError("NOT_FOUND", "That teammate no longer exists.");
  });
  await publish({ type: "bots" });
  return { ok: true };
}

/**
 * Archive a teammate: its chats are archived, its automations paused and its work stopped, all at
 * once. Its screen stops and its browser history goes; sign-ins stay shared with the other screens.
 */
export async function archiveTeammate({ teammateId }: Inputs["archive"]): Promise<{ ok: true }> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(teammates)
      .set({ archivedAt: now, isPrimary: false })
      .where(eq(teammates.id, teammateId));
    await tx
      .update(chats)
      .set({ archivedAt: now })
      .where(and(eq(chats.botId, teammateId), isNull(chats.archivedAt)));
    await tx.update(schedules).set({ enabled: false }).where(eq(schedules.botId, teammateId));
    await tx.update(triggers).set({ enabled: false }).where(eq(triggers.botId, teammateId));
    await tx
      .update(runs)
      .set({ cancelRequestedAt: now })
      .where(
        and(
          eq(runs.botId, teammateId),
          inArray(runs.status, ["queued", "starting", "running", "waiting"]),
        ),
      );
  });
  await afterSaving("telling the worker to stop its runs", () =>
    notify(pool, CHANNELS.worker, "cancel"),
  );
  await worker.screens.forget({ screenId: teammateId }).catch(() => {});
  await publish({ type: "bots" });
  return { ok: true };
}
