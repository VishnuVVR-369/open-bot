import "server-only";
import type { ApiInputs, ApiOutputs } from "@open-bot/api";
import {
  bots as teammates,
  CHANNELS,
  chats,
  notify,
  runs,
  schedules,
  settings,
  triggers,
} from "@open-bot/db";
import { slugify, teammateBundleSchema } from "@open-bot/domain";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { db, pool } from "../db";
import { memoryReady } from "../memory";
import { publish } from "../publish";
import { nextTeammateColor } from "../queries";
import { insertTeammateParts, teammateParts } from "../teammates";
import { worker } from "../worker";
import { ApiError } from "./errors";

type Inputs = ApiInputs["teammates"];
type Outputs = ApiOutputs["teammates"];

/** The teammate's name as a URL slug no other teammate has, like `scout-2`. */
async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  const taken = new Set(
    (await db.select({ slug: teammates.slug }).from(teammates)).map((row) => row.slug),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
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
  await (await memoryReady()).importLegacy();
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
  const slug = await uniqueSlug(name);
  const parts = await teammateParts(teammateId);
  const timezone = await ownerTimeZone();

  const created = await db.transaction(async (tx) => {
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
    memoryCopied = await (await memoryReady())
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
  const slug = await uniqueSlug(teammate.name);
  const timezone = await ownerTimeZone();

  const created = await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: teammates.id })
      .from(teammates)
      .where(isNull(teammates.archivedAt));
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
        isPrimary: existing.length === 0,
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
    const [lead] = await tx
      .update(teammates)
      .set({ isPrimary: true })
      .where(and(eq(teammates.id, teammateId), isNull(teammates.archivedAt)))
      .returning({ id: teammates.id });
    if (!lead) throw new ApiError("NOT_FOUND", "That teammate no longer exists.");
    await tx.update(teammates).set({ isPrimary: false }).where(ne(teammates.id, teammateId));
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
  await notify(pool, CHANNELS.worker, "cancel");
  await worker.screens.forget({ screenId: teammateId }).catch(() => {});
  await publish({ type: "bots" });
  return { ok: true };
}
