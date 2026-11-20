import { chatMembers, chats, LOCKS } from "@open-bot/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { mainChat } from "./";
import { rpcEnabled, rpcHarness, failure, ID } from "../../testing/rpc";

describe.skipIf(!rpcEnabled)("worker internal API, end to end", () => {
  const h = rpcHarness();
  const { pool, db, ctx, teammates, worker, newTeammate } = h;

  describe("chat and run writes", () => {
    it("starts direct and group chats, and renames, reads and archives them", async () => {
      const ada = await newTeammate("Ada", "researcher");
      const bea = await newTeammate("Bea", "writer");
      const { chatId } = await worker.chats.newDirect({ teammateId: ada.id });
      const [direct] = await db.select().from(chats).where(eq(chats.id, chatId));
      expect(direct).toMatchObject({ kind: "direct", title: "Ada", titled: false });
      expect(await failure(worker.chats.newDirect({ teammateId: ID }))).toEqual({
        status: 404,
        message: "That teammate no longer exists.",
      });

      const group = await worker.chats.createGroup({
        title: "Launch",
        teammateIds: [ada.id, bea.id, ada.id],
      });
      const members = await db
        .select({ teammateId: chatMembers.teammateId })
        .from(chatMembers)
        .where(eq(chatMembers.chatId, group.chatId));
      expect(members.map((m) => m.teammateId).sort()).toEqual([ada.id, bea.id].sort());
      expect(
        await failure(worker.chats.createGroup({ title: "Solo", teammateIds: [ada.id, ada.id] })),
      ).toEqual({ status: 400, message: "Pick at least two teammates." });
      expect(
        await failure(worker.chats.createGroup({ title: "Ghost", teammateIds: [ada.id, ID] })),
      ).toEqual({ status: 404, message: "One of those teammates no longer exists." });

      await worker.chats.rename({ chatId, title: "Research" });
      await worker.chats.markRead({ chatId });
      await worker.chats.archive({ chatId });
      const [changed] = await db.select().from(chats).where(eq(chats.id, chatId));
      expect(changed).toMatchObject({ title: "Research", titled: true });
      expect(changed!.readAt.getTime()).toBeGreaterThan(direct!.readAt.getTime());
      expect(changed!.archivedAt).not.toBeNull();
      for (const call of [
        () => worker.chats.rename({ chatId: ID, title: "Gone" }),
        () => worker.chats.markRead({ chatId: ID }),
        () => worker.chats.archive({ chatId: ID }),
      ])
        expect(await failure(call())).toEqual({
          status: 404,
          message: "That chat no longer exists.",
        });
    });

    it("keeps one main chat per teammate, and hands it on when it's archived", async () => {
      const ada = await newTeammate("Ada", "researcher");
      const chatTeammate = chats.teammateId;
      const main = async () =>
        (
          await db
            .select({ id: chats.id })
            .from(chats)
            .where(and(eq(chatTeammate, ada.id), eq(chats.main, true)))
        ).map((row) => row.id);
      // The chat a teammate starts with is its main chat; another one isn't.
      expect(await main()).toEqual([ada.chatId]);
      const { chatId: second } = await worker.chats.newDirect({ teammateId: ada.id });
      expect(await main()).toEqual([ada.chatId]);
      expect(await mainChat(ctx, ada.id)).toBe(ada.chatId);

      await worker.chats.makeMain({ chatId: second });
      expect(await main()).toEqual([second]);
      expect(await mainChat(ctx, ada.id)).toBe(second);

      // Archiving the main chat hands the role to the most recently active direct chat.
      await worker.chats.archive({ chatId: second });
      expect(await main()).toEqual([ada.chatId]);
      expect(await failure(worker.chats.makeMain({ chatId: second }))).toEqual({
        status: 400,
        message: "That chat is archived.",
      });

      // A worker from before main chats leaves none marked: Ada still links to her direct chat.
      await db.update(chats).set({ main: false }).where(eq(chats.id, ada.chatId));
      const path = `/chats/${ada.chatId}`;
      expect((await teammates.get(ada.id)).chatPath).toBe(path);
      expect((await teammates.list()).find((row) => row.id === ada.id)?.chatPath).toBe(path);
      await db.update(chats).set({ main: true }).where(eq(chats.id, ada.chatId));

      // A main chat archived by a worker from before main chats is replaced when it's needed.
      await db.update(chats).set({ archivedAt: new Date() }).where(eq(chats.id, ada.chatId));
      const made = await mainChat(ctx, ada.id);
      expect([ada.chatId, second]).not.toContain(made);
      expect(await main()).toEqual([made]);
      const [fresh] = await db.select().from(chats).where(eq(chats.id, made));
      expect(fresh).toMatchObject({ kind: "direct", title: "Ada", archivedAt: null });

      // With no main chat open, a new direct chat becomes the main one.
      await worker.chats.archive({ chatId: made });
      expect(await main()).toEqual([]);
      const { chatId: third } = await worker.chats.newDirect({ teammateId: ada.id });
      expect(await main()).toEqual([third]);

      const bea = await newTeammate("Bea", "writer");
      const group = await worker.chats.createGroup({
        title: "Launch",
        teammateIds: [ada.id, bea.id],
      });
      expect(await failure(worker.chats.makeMain({ chatId: group.chatId }))).toEqual({
        status: 400,
        message: "Only a chat with one teammate can be its main chat.",
      });
      expect(await failure(worker.chats.makeMain({ chatId: ID }))).toEqual({
        status: 404,
        message: "That chat no longer exists.",
      });
    });

    it("archives a main chat being made while its teammate is archived", async () => {
      const ada = await newTeammate("Ada", "researcher");
      await worker.chats.archive({ chatId: ada.chatId });
      // Work arrived for Ada, and mainChat() is about to add a chat: it holds the lock and has
      // checked that Ada is still on the team.
      const making = await pool.connect();
      try {
        await making.query("begin");
        await making.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
          LOCKS.mainChat(ada.id),
        ]);
        const archiving = worker.teammates.archive({ teammateId: ada.id });
        await vi.waitFor(async () => {
          const { rows } = await pool.query<{ waiting: number }>(
            "select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
          );
          expect(rows[0]!.waiting).toBe(1);
        });
        const insert = `insert into chats (kind, title, bot_id, main) values ('direct', 'Ada', $1, true) returning id`; // vocabulary: allow
        const { rows } = await making.query<{ id: string }>(insert, [ada.id]);
        await making.query("commit");
        await archiving;
        const [made] = await db.select().from(chats).where(eq(chats.id, rows[0]!.id));
        expect(made).toMatchObject({ main: false, archivedAt: expect.any(Date) });
      } finally {
        await making.query("rollback").catch(() => {});
        making.release();
      }
    });
  });
});
