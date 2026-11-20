import type { ApiClient } from "@open-bot/api";
import { beforeAll, describe, expect, it } from "vitest";
import { apiHarness, apiTestUrl, OWNER } from "@/test/api/harness";
import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/client";

// Keep the original suite name so full test names remain comparable across the move.
describe.skipIf(!apiTestUrl)("API reads, end to end", () => {
  const harness = apiHarness();
  const { ids, workerPaths, workerBodies, answers } = harness;
  let api: ApiClient;
  beforeAll(() => {
    api = harness.api;
  });

  it("serves the shell's state with the worker's status", async () => {
    const state = await api.app.state();
    expect(state.user).toEqual({ name: OWNER.name, email: OWNER.email });
    expect(state.timezone).toBe("Europe/Berlin");
    expect(state.teammates.map((bot) => bot.name)).toEqual(["Scout"]);
    expect(state.computer.workerOnline).toBe(true);
    expect(state.skills[0]).not.toHaveProperty("instructions");
    expect(state.unreadNotifications).toBe(1);
  });

  it("serves every list and detail the web app reads", async () => {
    expect((await api.schedules.list()).map((s) => s.title)).toEqual(["Morning news"]);
    expect(await api.schedules.runs({ scheduleId: ids.schedule })).toHaveLength(1);
    expect((await api.triggers.list()).map((t) => t.title)).toEqual(["Pricing page"]);
    expect(await api.triggers.runs({ triggerId: ids.trigger })).toEqual([]);
    expect((await api.skills.list()).map((s) => s.name)).toEqual(["summarize"]);
    expect((await api.tasks.list()).map((t) => t.title)).toEqual(["Book flights"]);
    expect(await api.vault.list()).toEqual([]);
    expect(await api.profile.get()).toMatchObject({ aboutMe: "" });
    expect((await api.teammates.lessons({ teammateId: ids.teammate })).map((l) => l.text)).toEqual([
      "Keep it short.",
    ]);
    expect(await api.teammates.spending({ teammateId: ids.teammate })).toMatchObject({
      spentCents: 1200,
    });
    expect((await api.connections.list()).map((c) => c.label)).toEqual(["Docs"]);
    expect((await api.accounts.setup()).accounts).toEqual([]);
    expect(await api.settings.modelAccess()).toMatchObject({ keyHint: null });
    expect(await api.settings.usage()).toEqual([]);
    expect(await api.screens.frames()).toEqual({});
    expect((await api.pages.list()).map((p) => p.title)).toEqual(["Trip plan"]);
    expect((await api.pages.search({ query: "trip" })).map((p) => p.id)).toEqual([ids.page]);
    expect((await api.notifications.list()).map((n) => n.title)).toEqual(["Done"]);
    expect(await api.approvals.list()).toEqual([]);
    expect(await api.search.messages({ query: "news" })).toEqual([]);
    const memories = await api.memory.list({ teammateId: ids.teammate, query: "window" });
    expect(memories.map((m) => m.content)).toEqual(["Prefers window seats"]);
    expect(memories[0]!.source).toMatchObject({ botId: ids.teammate, chatId: ids.chat });
    expect(await api.memory.list({ teammateId: null, query: "nothing like it" })).toEqual([]);
    const history = await api.memory.history({ memoryId: ids.memory });
    expect(history.map((r) => r.source.chatId)).toEqual([ids.chat]);
    expect(await api.memory.forRun({ runId: ids.run })).toEqual([]);
  });

  it("passes the worker's reads through", async () => {
    expect(await api.telegram.status()).toMatchObject({ connected: false });
    expect(await api.push.status()).toEqual({ publicKey: "key", devices: [] });
    expect(await api.email.status()).toMatchObject({ inboundPath: "/api/inbound/email/token" });
    expect(await api.settings.rateLimits()).toMatchObject({
      rateLimits: { primary: { usedPercent: 12 } },
    });
    expect((await api.files.list({ path: "/home/bot" })).entries.map((e) => e.name)).toEqual([
      "shared",
    ]);
    expect(workerPaths).toContain("/internal/files/list");
  });

  it("says the computer is offline with a 503 the browser can tell apart", async () => {
    harness.workerUp = false;
    try {
      const error = await api.telegram.status().catch((failed: unknown) => failed);
      expect(error).toBeInstanceOf(ORPCError);
      expect((error as ORPCError<string, unknown>).status).toBe(503);
      // Without the worker the shell still loads, and says it's offline.
      expect((await api.app.state()).computer.workerOnline).toBe(false);
    } finally {
      harness.workerUp = true;
    }
  });

  it("says what's gone, and rejects ids that aren't", async () => {
    const missing = randomUUID();
    await expect(api.teammates.spending({ teammateId: missing })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(api.pages.get({ pageId: missing })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(api.teammates.lessons({ teammateId: "not-an-id" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("passes vault, page and notification changes to the worker, which owns them", async () => {
    const itemId = randomUUID();
    const pageId = randomUUID();
    const login = {
      id: null,
      kind: "login" as const,
      name: "GitHub",
      domain: "github.com",
      teammateIds: [ids.teammate],
      secret: { username: "alex", password: "hunter22" },
    };
    const ok = { status: 200, body: { ok: true } };
    const calls: [string, () => Promise<unknown>, unknown, { status: number; body: unknown }][] = [
      [
        "/internal/vault",
        () => api.vault.save(login),
        login,
        { status: 200, body: { id: itemId } },
      ],
      [`/internal/vault/${itemId}/delete`, () => api.vault.remove({ itemId }), {}, ok],
      [
        `/internal/pages/${pageId}/pin`,
        () => api.pages.pin({ pageId, pinned: true }),
        { pinned: true },
        ok,
      ],
      [`/internal/pages/${pageId}/delete`, () => api.pages.remove({ pageId }), {}, ok],
      [
        "/internal/notifications/read",
        () => api.notifications.markRead({ through: itemId }),
        { through: itemId },
        ok,
      ],
    ];
    for (const [path, , , answer] of calls) answers.set(path, answer);
    try {
      for (const [path, call, body, answer] of calls) {
        expect(await call()).toEqual(answer.body);
        expect(workerBodies.findLast((b) => b.path === path)?.body ?? {}).toMatchObject(
          body as object,
        );
      }
      answers.set(`/internal/pages/${pageId}/pin`, {
        status: 404,
        body: { error: "That page was deleted.", code: "NOT_FOUND" },
      });
      await expect(api.pages.pin({ pageId, pinned: false })).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "That page was deleted.",
      });
      // The contract refuses an item nobody may use before it reaches the worker.
      await expect(api.vault.save({ ...login, teammateIds: [] })).rejects.toMatchObject({
        message: "Pick at least one teammate, or everyone.",
      });
    } finally {
      for (const [path] of calls) answers.delete(path);
    }
  });
});
