import type { AddressInfo } from "node:net";
import { OFFLINE_EGRESS_STATUS } from "@open-bot/api";
import { createWorkerClient } from "@open-bot/api/worker";
import {
  approvalRules,
  bots as teammateRows, // vocabulary: allow
  chats,
  instructionProposals,
  lessons,
  runs,
  schedules as scheduleRows,
  triggers as triggerRows,
} from "@open-bot/db";
import { BUNDLE_FORMAT, BUNDLE_VERSION, type TeammateBundle } from "@open-bot/domain";
import { and, eq, isNull, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { rpcEnabled, rpcHarness, failure, ID } from "../testing/rpc";

describe.skipIf(!rpcEnabled)("worker internal API, end to end", () => {
  const h = rpcHarness();
  const { pool, db, codexStatus, ctx, sync, memory, teammates, server, worker, teammateWithRun } =
    h;

  it("status: reports the computer, Codex and egress without waking anything", async () => {
    expect(await worker.status.get()).toEqual({
      computer: { online: true, health: null, lifecycle: null },
      codex: codexStatus,
      egress: OFFLINE_EGRESS_STATUS,
    });
  });

  it("refuses a caller without the worker's secret", async () => {
    const stranger = createWorkerClient({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      secret: "wrong",
    });
    expect(await failure(stranger.status.get())).toEqual({ status: 401, message: "unauthorized" });
    expect(await db.select().from(chats).where(eq(chats.id, ID))).toEqual([]);
  });

  describe("teammate writes", () => {
    /** A row's teammate, under the column's legacy name. */
    const owned = (teammateId: string) => ({ botId: teammateId }); // vocabulary: allow
    /** A teammate file with this name, and these parts. */
    const file = (name: string, parts: Partial<TeammateBundle> = {}): TeammateBundle => ({
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      teammate: { name, role: "Helper", instructions: "", emoji: "", autonomy: "risky" },
      skills: [],
      routines: [],
      watches: [],
      allowed: [],
      lessons: [],
      ...parts,
    });
    const imported = (name: string, parts?: Partial<TeammateBundle>) =>
      worker.teammates.import({ bundle: file(name, parts) });

    type Row = {
      id: string;
      name: string;
      slug: string;
      archived: boolean;
      lead: boolean;
      updatedAt: string;
    };
    async function team(): Promise<Row[]> {
      const { rows } = await db.execute<Row>(
        sql`select id, name, slug, archived_at is not null as archived, is_primary as lead, updated_at::text as "updatedAt" from bots`, // vocabulary: allow
      );
      return rows;
    }
    const row = async (id: string) => (await team()).find((entry) => entry.id === id)!;
    const leads = async () =>
      (await team()).filter((entry) => entry.lead).map((entry) => entry.name);

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
        .where(eq(scheduleRows.botId, atlas.teammateId)); // vocabulary: allow
      // The cron it can't read is left out; the other starts paused in the owner's time zone.
      expect(routines.map((r) => [r.title, r.enabled, r.timezone])).toEqual([
        ["Weekly plan", false, "Asia/Kolkata"],
      ]);
      const watches = await db
        .select()
        .from(triggerRows)
        .where(eq(triggerRows.botId, atlas.teammateId)); // vocabulary: allow
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
        .where(eq(lessons.botId, atlas.teammateId)); // vocabulary: allow
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
        .where(eq(approvalRules.botId, kit.teammateId)); // vocabulary: allow
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
        .where(eq(scheduleRows.botId, copy.teammateId)); // vocabulary: allow
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

    it("makes one teammate the lead, refusing one that's gone, and touches only the two", async () => {
      const iris = await imported("Iris");
      const kit = await imported("Kit");
      const bystander = await imported("Bystander");
      const gone = await imported("Gone");
      await worker.teammates.archive({ teammateId: gone.teammateId });
      await worker.teammates.setLead({ teammateId: iris.teammateId });
      expect(await leads()).toEqual(["Iris"]);
      const before = (await row(bystander.teammateId)).updatedAt;
      await worker.teammates.setLead({ teammateId: kit.teammateId });
      await worker.teammates.setLead({ teammateId: iris.teammateId });
      expect(await leads()).toEqual(["Iris"]);
      // Only the rows that change, so other teammates keep their revisions.
      expect((await row(bystander.teammateId)).updatedAt).toBe(before);
      for (const teammateId of [gone.teammateId, ID])
        expect(await failure(worker.teammates.setLead({ teammateId }))).toEqual({
          status: 404,
          message: "That teammate no longer exists.",
        });
      expect(await leads()).toEqual(["Iris"]);
    });

    it("keeps exactly one lead when two are chosen at once", async () => {
      const juno = await imported("Juno");
      const max = await imported("Max");
      for (let round = 0; round < 10; round += 1) {
        await Promise.all([
          worker.teammates.setLead({ teammateId: juno.teammateId }),
          worker.teammates.setLead({ teammateId: max.teammateId }),
        ]);
        expect(await leads()).toHaveLength(1);
      }
    });

    it("archives a teammate: its chats, automations and work stop together", async () => {
      const { teammateId, chatId } = await imported("Retiring", {
        routines: [{ title: "Digest", prompt: "Sum up", cron: "0 18 * * *", quiet: false }],
      });
      await worker.teammates.setLead({ teammateId });
      const [run] = await db
        .insert(runs)
        .values({ chatId, ...owned(teammateId), trigger: "user", prompt: "Go", status: "queued" })
        .returning({ id: runs.id });
      await db
        .update(scheduleRows)
        .set({ enabled: true })
        .where(eq(scheduleRows.botId, teammateId)); // vocabulary: allow
      await worker.teammates.archive({ teammateId });
      expect(await row(teammateId)).toMatchObject({ archived: true, lead: false });
      const [chat] = await db.select().from(chats).where(eq(chats.id, chatId));
      expect(chat!.archivedAt).not.toBeNull();
      const routines = await db
        .select()
        .from(scheduleRows)
        .where(eq(scheduleRows.botId, teammateId)); // vocabulary: allow
      expect(routines.map((r) => r.enabled)).toEqual([false]);
      const [stopped] = await db.select().from(runs).where(eq(runs.id, run!.id));
      expect(stopped!.cancelRequestedAt).not.toBeNull();
      expect(ctx.computer.forgetScreen).toHaveBeenLastCalledWith(teammateId);
    });

    it("archives a teammate while a memory write holds its runs, without deadlocking", async () => {
      const { teammateId, chatId } = await imported("Busy");
      await db
        .insert(runs)
        .values({ chatId, ...owned(teammateId), trigger: "user", prompt: "Go", status: "running" });
      // A memory write's order (packages/memory, `changed()`): the teammate's runs, then its row.
      const memoryWrite = await pool.connect();
      try {
        await memoryWrite.query("begin");
        await memoryWrite.query(
          "update runs set cancel_requested_at = now() where bot_id = $1", // vocabulary: allow
          [teammateId],
        );
        const archiving = worker.teammates.archive({ teammateId });
        // Wait until archiving waits on a lock the memory write holds.
        for (;;) {
          const { rows } = await pool.query<{ waiting: number }>(
            "select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
          );
          if (rows[0]!.waiting > 0) break;
          await new Promise((resolve) => setImmediate(resolve));
        }
        await memoryWrite.query(
          "update bots set lessons_changed_at = now() where id = $1", // vocabulary: allow
          [teammateId],
        );
        await memoryWrite.query("commit");
        await archiving;
      } finally {
        memoryWrite.release();
      }
      expect(await row(teammateId)).toMatchObject({ archived: true });
    });

    it("sets a budget in dollars, refusing an auto-approve over it", async () => {
      const { teammateId } = await imported("Spender");
      const budget = (budget: number | null, autoApprove: number, id = teammateId) =>
        worker.teammates.setBudget({ teammateId: id, budget, autoApprove });
      expect(await failure(budget(50, 80))).toEqual({
        status: 400,
        message: "The amount to approve on its own can't be more than the budget.",
      });
      expect(await failure(budget(50, 0, ID))).toMatchObject({ status: 404 });
      await budget(120.5, 20);
      const [spender] = await db.select().from(teammateRows).where(eq(teammateRows.id, teammateId));
      expect(spender).toMatchObject({ monthlyBudgetCents: 12_050, autoApproveCents: 2000 });
      await budget(null, 0);
      const [none] = await db.select().from(teammateRows).where(eq(teammateRows.id, teammateId));
      expect(none!.monthlyBudgetCents).toBeNull();
    });

    it("applies suggested instructions once, and says when a suggestion went the other way", async () => {
      const { teammateId } = await imported("Writer");
      await teammates.proposeInstructions({
        teammateId,
        current: "",
        proposed: "Answer in bullets.",
        reason: "Shorter",
        runId: (await teammateWithRun()).run.id,
      });
      const [waiting] = await db
        .select()
        .from(instructionProposals)
        .where(
          and(
            eq(instructionProposals.status, "pending"),
            eq(instructionProposals.botId, teammateId),
          ),
        ); // vocabulary: allow
      await worker.proposals.accept({ proposalId: waiting!.id });
      const instructions = async () =>
        (await db.select().from(teammateRows).where(eq(teammateRows.id, teammateId)))[0]!
          .instructions;
      expect(await instructions()).toBe("Answer in bullets.");
      expect(sync).toHaveBeenLastCalledWith(expect.objectContaining({ id: teammateId }));
      await worker.proposals.accept({ proposalId: waiting!.id });
      expect(await failure(worker.proposals.dismiss({ proposalId: waiting!.id }))).toEqual({
        status: 409,
        message: "That suggestion was already handled.",
      });
      // A newer suggestion dismisses the one waiting.
      const runId = (await teammateWithRun()).run.id;
      await teammates.proposeInstructions({
        teammateId,
        current: "",
        proposed: "Use headings.",
        reason: "Clearer",
        runId,
      });
      const [older] = await db
        .select()
        .from(instructionProposals)
        .where(
          and(
            eq(instructionProposals.status, "pending"),
            eq(instructionProposals.botId, teammateId),
          ),
        ); // vocabulary: allow
      await teammates.proposeInstructions({
        teammateId,
        current: "",
        proposed: "Use tables.",
        reason: "Clearer",
        runId,
      });
      expect(await failure(worker.proposals.accept({ proposalId: older!.id }))).toEqual({
        status: 409,
        message: "A newer suggestion replaced this one.",
      });
      expect(await failure(worker.proposals.dismiss({ proposalId: ID }))).toMatchObject({
        status: 404,
      });
    });

    it("removes a schedule, and a schedule already gone is fine", async () => {
      const { teammateId } = await imported("Planner", {
        routines: [{ title: "Plan", prompt: "Plan", cron: "0 9 * * *", quiet: false }],
      });
      const [routine] = await db
        .select()
        .from(scheduleRows)
        .where(eq(scheduleRows.botId, teammateId)); // vocabulary: allow
      await worker.schedules.remove({ scheduleId: routine!.id });
      await worker.schedules.remove({ scheduleId: routine!.id });
      expect(await db.select().from(scheduleRows).where(eq(scheduleRows.id, routine!.id))).toEqual(
        [],
      );
    });

    // Last: it empties the team.
    it("lets only one of two teammates imported at once into an empty team lead", async () => {
      await db
        .update(teammateRows)
        .set({ archivedAt: new Date(), isPrimary: false }) // vocabulary: allow
        .where(isNull(teammateRows.archivedAt)); // vocabulary: allow
      expect(await leads()).toEqual([]);
      await Promise.all(["Ada", "Bea"].map((name) => imported(name)));
      expect(await leads()).toHaveLength(1);
    });
  });
});
