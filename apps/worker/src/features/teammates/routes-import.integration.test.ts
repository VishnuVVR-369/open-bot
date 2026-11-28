import {
  approvalRules,
  chats,
  lessons,
  schedules as scheduleRows,
  triggers as triggerRows,
} from "@open-bot/db";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { teammateRouteHarness } from "./testing-routes";
import { rpcEnabled, rpcHarness, failure, ID } from "../../testing/rpc";

describe.skipIf(!rpcEnabled)("worker internal API, end to end", () => {
  const h = rpcHarness();
  const { db, sync, memory, worker } = h;

  describe("teammate writes", () => {
    const { owned, imported, team, row } = teammateRouteHarness(h);

    it("imports a file: parts come along, routines and watches paused, lessons into memory", async () => {
      const atlas = await imported("Atlas", {
        skills: [{ name: "atlas-brief", description: "Brief me", instructions: "Write a brief." }],
        routines: [
          { title: "Weekly plan", prompt: "Plan the week", cron: "0 9 * * 1", quiet: false },
          { title: "Broken", prompt: "Never", cron: "not a cron", quiet: false },
        ],
        watches: [
          {
            title: "Pricing",
            prompt: "Tell me",
            url: "https://example.test/pricing",
            intervalMinutes: 60,
            lookFor: null,
          },
        ],
        allowed: [{ kind: "command", pattern: "  git   status " }],
        lessons: ["Keep answers short."],
      });
      expect(atlas).toMatchObject({ name: "Atlas", paused: 3 });
      expect(await row(atlas.teammateId)).toMatchObject({ slug: "atlas" });
      const routines = await db
        .select()
        .from(scheduleRows)
        .where(eq(scheduleRows.teammateId, atlas.teammateId));
      // The cron it can't read is left out; the other starts paused in the owner's time zone.
      expect(routines.map((r) => [r.title, r.enabled, r.timezone])).toEqual([
        ["Weekly plan", false, "Asia/Kolkata"],
      ]);
      const watches = await db
        .select()
        .from(triggerRows)
        .where(eq(triggerRows.teammateId, atlas.teammateId));
      expect(watches.map((w) => [w.title, w.enabled])).toEqual([["Pricing", false]]);
      const exported = await worker.teammates.export({ teammateId: atlas.teammateId });
      expect(exported.slug).toBe("atlas");
      expect(exported.bundle).toMatchObject({
        skills: [{ name: "atlas-brief" }],
        allowed: [{ kind: "command", pattern: "git status" }],
        lessons: ["Keep answers short."],
      });
      // A lesson lives in memory, so the next memory change keeps it.
      await memory.addLessons(atlas.teammateId, ["Cite sources."]);
      const learned = await db
        .select({ text: lessons.text })
        .from(lessons)
        .where(eq(lessons.teammateId, atlas.teammateId));
      expect(learned.map((l) => l.text).sort()).toEqual(["Cite sources.", "Keep answers short."]);
    });

    it("keeps every rule and lesson a file carries whole, and exports what memory holds", async () => {
      // Cut short, this rule would allow every `git -C <dir>` command, not only `status`.
      const pattern = `git -C /home/bot/${"d".repeat(280)} status`;
      expect(pattern.length).toBeGreaterThan(300);
      const kit = await imported("Kit", {
        allowed: [{ kind: "command", pattern }],
        lessons: ["简洁"],
      });
      const rules = await db
        .select({ pattern: approvalRules.pattern })
        .from(approvalRules)
        .where(eq(approvalRules.teammateId, kit.teammateId));
      expect(rules).toEqual([{ pattern }]);
      // A lesson longer than a file allows, which memory holds, still exports.
      const long = `Explain it. ${"x".repeat(600)}`;
      await memory.addLessons(kit.teammateId, [long]);
      const exported = await worker.teammates.export({ teammateId: kit.teammateId });
      expect(exported.bundle.allowed).toEqual([{ kind: "command", pattern }]);
      expect([...exported.bundle.lessons].sort()).toEqual([long, "简洁"].sort());
    });

    it("adds nobody when a teammate's lessons can't be saved", async () => {
      vi.spyOn(memory, "addLessons").mockRejectedValueOnce(new Error("memory is down"));
      expect(await failure(imported("Ghost", { lessons: ["Be brief."] }))).toMatchObject({
        status: 500,
      });
      expect((await team()).filter((entry) => entry.name === "Ghost")).toEqual([]);
      const ghostChats = await db.select().from(chats).where(eq(chats.title, "Ghost"));
      expect(ghostChats).toEqual([]);
    });

    it("duplicates a teammate with its memory and reminders, and refuses one that's gone", async () => {
      const scout = await imported("Scout", {
        routines: [{ title: "Morning news", prompt: "News", cron: "0 8 * * *", quiet: false }],
        lessons: ["Prefer primary sources."],
      });
      await db.insert(scheduleRows).values({
        ...owned(scout.teammateId),
        title: "Call mom",
        prompt: "Remind me",
        kind: "once",
        runAt: new Date(Date.now() + 86_400_000),
        nextRunAt: new Date(Date.now() + 86_400_000),
        timezone: "Asia/Kolkata",
        createdBy: "user",
      });
      await memory.save(
        {
          ...owned(scout.teammateId),
          kind: "fact",
          content: "Prefers window seats",
          key: null,
          pinned: false,
          expiresAt: null,
        },
        { kind: "user" },
      );
      const copy = await worker.teammates.duplicate({
        teammateId: scout.teammateId,
        name: "Scout",
        copyMemory: true,
      });
      expect(copy.memoryCopied).toBe(true);
      expect(await row(copy.teammateId)).toMatchObject({
        name: "Scout",
        slug: "scout-2",
        lead: false,
      });
      const [chat] = await db.select().from(chats).where(eq(chats.id, copy.chatId));
      expect(chat).toMatchObject({ kind: "direct", ...owned(copy.teammateId) });
      const copied = await db
        .select()
        .from(scheduleRows)
        .where(eq(scheduleRows.teammateId, copy.teammateId));
      expect(copied.map((r) => [r.title, r.enabled]).sort()).toEqual([
        ["Call mom", false],
        ["Morning news", false],
      ]);
      const memories = await memory.list({ ...owned(copy.teammateId) }, { kind: "user" });
      expect(memories.map((m) => m.content).sort()).toEqual([
        "Prefer primary sources.",
        "Prefers window seats",
      ]);
      expect(sync).toHaveBeenLastCalledWith(expect.objectContaining({ id: copy.teammateId }));
      // Without memory, no lessons either.
      const bare = await worker.teammates.duplicate({
        teammateId: scout.teammateId,
        name: "Bare",
        copyMemory: false,
      });
      expect(await memory.list({ ...owned(bare.teammateId) }, { kind: "user" })).toEqual([]);
      expect(
        await failure(
          worker.teammates.duplicate({ teammateId: ID, name: "Nobody", copyMemory: false }),
        ),
      ).toMatchObject({ status: 404 });
    });

    it("answers an ask sent again under the same copy id with that copy, and finishes its memory", async () => {
      const wren = await imported("Wren", { lessons: ["Cite sources."] });
      await memory.save(
        {
          ...owned(wren.teammateId),
          kind: "fact",
          content: "Likes tea",
          key: null,
          pinned: false,
          expiresAt: null,
        },
        { kind: "user" },
      );
      const copyMemory = vi
        .spyOn(memory, "copyTeammate")
        .mockRejectedValueOnce(new Error("The memory store is away."));
      const copyId = randomUUID();
      const ask = { teammateId: wren.teammateId, name: "Wren 2", copyMemory: true, copyId };
      // The first ask makes the copy under that id, but its memory doesn't come along.
      const first = await worker.teammates.duplicate(ask);
      expect(first).toMatchObject({ teammateId: copyId, memoryCopied: false });
      // Asked again (its answer was lost, say), it's the same copy, and its memory comes now.
      const again = await worker.teammates.duplicate(ask);
      expect(again).toEqual({ ...first, memoryCopied: true });
      const contents = async () =>
        (await memory.list({ ...owned(copyId) }, { kind: "user" })).map((m) => m.content).sort();
      expect(await contents()).toEqual(["Cite sources.", "Likes tea"]);
      // Once it came along, it isn't copied again, and other words in the ask don't matter.
      const calls = copyMemory.mock.calls.length;
      expect(
        await worker.teammates.duplicate({ ...ask, name: "Someone else", copyMemory: false }),
      ).toEqual(again);
      expect(copyMemory.mock.calls.length).toBe(calls);
      expect((await team()).filter((entry) => entry.name.startsWith("Wren 2"))).toHaveLength(1);
      expect(await row(copyId)).toMatchObject({ name: "Wren 2", slug: "wren-2" });
      expect(await db.select().from(chats).where(eq(chats.teammateId, copyId))).toHaveLength(1);

      // Two asks at once, the second sent while the first is still making it: one copy.
      const twinId = randomUUID();
      const twins = await Promise.all(
        [1, 2].map(() => worker.teammates.duplicate({ ...ask, name: "Twin", copyId: twinId })),
      );
      expect(twins[0]).toEqual(twins[1]);
      expect(twins[0]).toMatchObject({ teammateId: twinId, memoryCopied: true });
      expect((await team()).filter((entry) => entry.name === "Twin")).toHaveLength(1);
      expect(await memory.list({ ...owned(twinId) }, { kind: "user" })).toHaveLength(2);

      // The original archived since: the copy the first ask made still answers, a new one doesn't.
      await worker.teammates.archive({ teammateId: wren.teammateId });
      expect(await worker.teammates.duplicate(ask)).toEqual(again);
      expect(
        await failure(worker.teammates.duplicate({ ...ask, copyId: randomUUID() })),
      ).toMatchObject({ status: 404 });
      // The copy itself archived since: asking again says so, and doesn't make another.
      await worker.teammates.archive({ teammateId: copyId });
      expect(await failure(worker.teammates.duplicate(ask))).toMatchObject({
        status: 404,
        message: expect.stringContaining("archived since"),
      });
      expect(
        (await team())
          .filter((entry) => entry.name.startsWith("Wren 2"))
          .map((entry) => [entry.id, entry.archived]),
      ).toEqual([[copyId, true]]);
      copyMemory.mockRestore();
    });

    it("refuses a copy id that's another teammate's, or a copy of someone else", async () => {
      const kite = await imported("Kite");
      const other = await imported("Other");
      const copy = await worker.teammates.duplicate({
        teammateId: other.teammateId,
        name: "Other 2",
        copyMemory: false,
        copyId: randomUUID(),
      });
      for (const copyId of [other.teammateId, kite.teammateId, copy.teammateId])
        expect(
          await failure(
            worker.teammates.duplicate({
              teammateId: kite.teammateId,
              name: "Kite 2",
              copyMemory: false,
              copyId,
            }),
          ),
        ).toMatchObject({ status: 409, message: expect.stringContaining("another teammate") });
      expect((await team()).filter((entry) => entry.name === "Kite 2")).toEqual([]);
    });

    it("gives copies made at once different slugs", async () => {
      const echo = await imported("Original");
      const copies = await Promise.all(
        [1, 2, 3].map(() =>
          worker.teammates.duplicate({
            teammateId: echo.teammateId,
            name: "Echo",
            copyMemory: false,
          }),
        ),
      );
      const slugs = await Promise.all(copies.map(async (c) => (await row(c.teammateId)).slug));
      expect(slugs.sort()).toEqual(["echo", "echo-2", "echo-3"]);
    });
  });
});
