import type { ApiClient } from "@open-bot/api";
import { beforeAll, describe, expect, it } from "vitest";
import { apiHarness, apiTestUrl } from "@/test/api/harness";
import { randomUUID } from "node:crypto";
import { BUNDLE_FORMAT, BUNDLE_VERSION } from "@open-bot/domain";
import { eq, inArray } from "drizzle-orm";

// Keep the original suite name so full test names remain comparable across the move.
describe.skipIf(!apiTestUrl)("API reads, end to end", () => {
  const harness = apiHarness();
  const { database, ids, owned, workerPaths, workerBodies, answers } = harness;
  let api: ApiClient;
  beforeAll(() => {
    api = harness.api;
  });

  const PROFILE = {
    name: "Iris",
    role: "Writer",
    instructions: "",
    color: "#10b981",
    emoji: "",
    autonomy: "risky" as const,
  };

  /** A teammate file with this name. */
  const teammateFile = (name: string, version = BUNDLE_VERSION) =>
    JSON.stringify({ format: BUNDLE_FORMAT, version, teammate: { name, role: "Helper" } });

  it("links a teammate to its main chat, or to its latest direct chat while none is marked", async () => {
    const s = await import("@open-bot/db");
    const db = database.db;
    const linked = async () => (await api.app.state()).teammates[0]!.directChatId;
    // As a worker from before main chats leaves it: direct chats, none of them marked.
    expect(await linked()).toBe(ids.chat);
    const [newer] = await db
      .insert(s.chats)
      .values({
        kind: "direct",
        title: "Scout",
        lastActivityAt: new Date(Date.now() + 60_000),
        ...owned(ids.teammate),
      })
      .returning();
    try {
      expect(await linked()).toBe(newer!.id);
      await db.update(s.chats).set({ main: true }).where(eq(s.chats.id, ids.chat));
      expect(await linked()).toBe(ids.chat);
    } finally {
      await db.update(s.chats).set({ main: false }).where(eq(s.chats.id, ids.chat));
      await db.delete(s.chats).where(eq(s.chats.id, newer!.id));
    }
  });

  it("passes teammate changes to the worker, which owns them, after checking a file", async () => {
    await expect(api.teammates.import({ file: "{" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This isn't an open-bot teammate file.",
    });
    await expect(
      api.teammates.import({ file: teammateFile("Atlas", BUNDLE_VERSION + 1) }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("from a newer open-bot"),
    });
    expect(workerPaths.some((path) => path === "/internal/teammates/import")).toBe(false);

    const teammateId = ids.teammate;
    const proposalId = randomUUID();
    const scheduleId = randomUUID();
    const ok = { status: 200, body: { ok: true } };
    const created = { teammateId: randomUUID(), chatId: randomUUID() };
    const calls: [string, () => Promise<unknown>, unknown][] = [
      [
        "/internal/teammates/import",
        () => api.teammates.import({ file: teammateFile("Atlas") }),
        { bundle: { teammate: { name: "Atlas", role: "Helper" }, routines: [] } },
      ],
      [
        `/internal/teammates/${teammateId}/duplicate`,
        () => api.teammates.duplicate({ teammateId, name: "Scout 2", copyMemory: true }),
        { name: "Scout 2", copyMemory: true },
      ],
      [`/internal/teammates/${teammateId}/lead`, () => api.teammates.setLead({ teammateId }), {}],
      [
        `/internal/teammates/${teammateId}/archive`,
        () => api.teammates.archive({ teammateId }),
        {},
      ],
      [
        `/internal/teammates/${teammateId}/budget`,
        () => api.teammates.setBudget({ teammateId, budget: 120.5, autoApprove: 20 }),
        { budget: 120.5, autoApprove: 20 },
      ],
      [
        `/internal/proposals/${proposalId}/accept`,
        () => api.proposals.accept({ proposalId, expectedInstructions: "Be brief." }),
        { expectedInstructions: "Be brief." },
      ],
      [
        `/internal/proposals/${proposalId}/dismiss`,
        () => api.proposals.dismiss({ proposalId }),
        {},
      ],
      [`/internal/schedules/${scheduleId}/delete`, () => api.schedules.remove({ scheduleId }), {}],
    ];
    answers.set("/internal/teammates/import", {
      status: 200,
      body: { ...created, name: "Atlas", paused: 0 },
    });
    answers.set(`/internal/teammates/${teammateId}/duplicate`, {
      status: 200,
      body: { ...created, memoryCopied: true },
    });
    for (const [path] of calls.slice(2)) answers.set(path, ok);
    try {
      for (const [path, call, body] of calls) {
        await call();
        expect(workerBodies.findLast((b) => b.path === path)?.body ?? {}).toMatchObject(
          body as object,
        );
      }
      // The worker's refusals keep its words and become the contract's errors.
      answers.set(`/internal/teammates/${teammateId}/lead`, {
        status: 404,
        body: { error: "That teammate no longer exists.", code: "NOT_FOUND" },
      });
      await expect(api.teammates.setLead({ teammateId })).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "That teammate no longer exists.",
      });
      answers.set(`/internal/proposals/${proposalId}/dismiss`, {
        status: 409,
        body: { error: "That suggestion was already handled.", code: "CONFLICT" },
      });
      await expect(api.proposals.dismiss({ proposalId })).rejects.toMatchObject({
        code: "STATE_CONFLICT",
        message: "That suggestion was already handled.",
      });
      // Accepting names the instructions you reviewed, so a stale change can't overwrite newer ones.
      const sent = workerBodies.length;
      await expect(
        api.proposals.accept({ proposalId } as Parameters<typeof api.proposals.accept>[0]),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(workerBodies).toHaveLength(sent);
    } finally {
      for (const [path] of calls) answers.delete(path);
    }
  });

  it("reads the suggestion waiting from a teammate, with its instructions now", async () => {
    const s = await import("@open-bot/db");
    const db = database.db;
    expect(await api.proposals.pending({ teammateId: ids.teammate })).toBeNull();
    const [teammate] = await db
      .select({ instructions: s.teammates.instructions })
      .from(s.teammates)
      .where(eq(s.teammates.id, ids.teammate));
    const [older, newer] = await db
      .insert(s.instructionProposals)
      .values([
        {
          teammateId: ids.teammate,
          current: "Be brief.",
          proposed: "Be brief.\nCite sources.",
          reason: "You asked for sources twice.",
          status: "dismissed",
          createdAt: new Date(Date.now() - 60_000),
        },
        {
          teammateId: ids.teammate,
          current: "Be brief.",
          proposed: "Be brief.\nAsk before booking.",
          reason: "You corrected two bookings.",
        },
      ])
      .returning();
    try {
      expect(await api.proposals.pending({ teammateId: ids.teammate })).toEqual({
        id: newer!.id,
        teammateId: ids.teammate,
        current: "Be brief.",
        proposed: "Be brief.\nAsk before booking.",
        reason: "You corrected two bookings.",
        createdAt: newer!.createdAt.toISOString(),
        instructionsNow: teammate!.instructions,
      });
      await expect(api.proposals.pending({ teammateId: randomUUID() })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    } finally {
      await db
        .delete(s.instructionProposals)
        .where(inArray(s.instructionProposals.id, [older!.id, newer!.id]));
    }
  });

  it("says a teammate changed since it was loaded as a state conflict, in the worker's words", async () => {
    const message = "Scout changed since you opened this. Reload to see the latest.";
    answers.set(`/internal/teammates/${ids.teammate}`, { status: 409, body: { error: message } });
    try {
      await expect(
        api.teammates.update({ teammateId: ids.teammate, profile: PROFILE, revision: "old" }),
      ).rejects.toMatchObject({ code: "STATE_CONFLICT", status: 409, message });
    } finally {
      answers.clear();
    }
  });

  it("sends only the profile fields given, checking only those", async () => {
    const path = `/internal/teammates/${ids.teammate}`;
    answers.set(path, {
      status: 200,
      body: { teammateId: ids.teammate, revision: "next", workspaceSynced: true },
    });
    try {
      await api.teammates.update({
        teammateId: ids.teammate,
        profile: { role: "Editor" },
        revision: "r1",
      });
      expect(workerBodies.findLast((body) => body.path === path)?.body).toEqual({
        changes: { role: "Editor" },
        expected_revision: "r1",
      });
      // Nothing to change, or a field against the rules, never reaches the worker.
      const sent = workerBodies.length;
      for (const profile of [{}, { emoji: "🦊🐙" }, { color: "teal" }])
        await expect(
          api.teammates.update({ teammateId: ids.teammate, profile, revision: "r1" }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(workerBodies).toHaveLength(sent);
    } finally {
      answers.clear();
    }
  });

  it("duplicates under the client's copy id, and says an id taken is a conflict", async () => {
    const path = `/internal/teammates/${ids.teammate}/duplicate`;
    const copyId = randomUUID();
    answers.set(path, {
      status: 200,
      body: { teammateId: copyId, chatId: randomUUID(), memoryCopied: false },
    });
    try {
      const ask = { teammateId: ids.teammate, name: "Scout 2", copyMemory: true, copyId };
      expect(await api.teammates.duplicate(ask)).toMatchObject({
        teammateId: copyId,
        memoryCopied: false,
      });
      expect(workerBodies.findLast((body) => body.path === path)?.body).toEqual({
        name: "Scout 2",
        copyMemory: true,
        copyId,
      });
      // A client from before copy ids still duplicates.
      await api.teammates.duplicate({
        teammateId: ids.teammate,
        name: "Scout 3",
        copyMemory: false,
      });
      expect(workerBodies.findLast((body) => body.path === path)?.body).toEqual({
        name: "Scout 3",
        copyMemory: false,
      });
      const message = "That id is already another teammate's. Duplicate again with a new one.";
      answers.set(path, { status: 409, body: { error: message } });
      await expect(api.teammates.duplicate(ask)).rejects.toMatchObject({
        code: "CONFLICT",
        status: 409,
        message,
      });
    } finally {
      answers.clear();
    }
  });

  it("reads a teammate's profile to edit, with a revision only the profile changes", async () => {
    const s = await import("@open-bot/db");
    const db = database.db;
    const [row] = await db.select().from(s.teammates).where(eq(s.teammates.id, ids.teammate));
    const read = await api.teammates.profile({ teammateId: ids.teammate });
    expect(read).toEqual({
      teammateId: ids.teammate,
      profile: {
        name: row!.name,
        role: row!.role,
        instructions: row!.instructions,
        color: row!.color,
        emoji: row!.emoji,
        autonomy: row!.autonomy,
      },
      revision: s.teammateRevision(row!),
    });
    try {
      // Its budget, the lead and a lesson change the row, not what you edit.
      await db
        .update(s.teammates)
        .set({ monthlyBudgetCents: 5000, isLead: !row!.isLead, lessonsChangedAt: new Date() })
        .where(eq(s.teammates.id, ids.teammate));
      expect((await api.teammates.profile({ teammateId: ids.teammate })).revision).toBe(
        read.revision,
      );
      await db
        .update(s.teammates)
        .set({ instructions: `${row!.instructions}\nCite sources.` })
        .where(eq(s.teammates.id, ids.teammate));
      const changed = await api.teammates.profile({ teammateId: ids.teammate });
      expect(changed.revision).not.toBe(read.revision);
      expect(changed.profile.instructions).toBe(`${row!.instructions}\nCite sources.`);

      // A save sends the whole profile and that revision to the worker, which checks it.
      const path = `/internal/teammates/${ids.teammate}`;
      answers.set(path, {
        status: 200,
        body: { teammateId: ids.teammate, revision: "next", workspaceSynced: true },
      });
      await api.teammates.update({
        teammateId: ids.teammate,
        profile: { ...changed.profile, role: "Editor" },
        revision: changed.revision,
      });
      expect(workerBodies.findLast((body) => body.path === path)?.body).toEqual({
        changes: { ...changed.profile, role: "Editor" },
        expected_revision: changed.revision,
      });

      // Archived, or never there: not found.
      await db
        .update(s.teammates)
        .set({ archivedAt: new Date() })
        .where(eq(s.teammates.id, ids.teammate));
      for (const teammateId of [ids.teammate, randomUUID()])
        await expect(api.teammates.profile({ teammateId })).rejects.toMatchObject({
          code: "NOT_FOUND",
          message: "That teammate no longer exists or is archived.",
        });
    } finally {
      answers.clear();
      const { id: _id, createdAt: _created, updatedAt: _updated, ...rest } = row!;
      await db.update(s.teammates).set(rest).where(eq(s.teammates.id, ids.teammate));
    }
  });
});
