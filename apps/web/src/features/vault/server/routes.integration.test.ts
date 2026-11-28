import type { ApiClient } from "@open-bot/api";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { apiHarness, apiTestUrl } from "@/test/api/harness";

describe.skipIf(!apiTestUrl)("the vault's writes, end to end", () => {
  const harness = apiHarness();
  const { workerBodies, answers } = harness;
  let api: ApiClient;
  beforeAll(() => {
    api = harness.api;
  });

  it("sends a patch's fields to the worker as given, and nothing else", async () => {
    const itemId = randomUUID();
    const path = `/internal/vault/${itemId}/patch`;
    answers.set(path, { status: 200, body: { id: itemId } });
    try {
      expect(
        await api.vault.patch({ itemId, teammateIds: null, secret: { password: "made-up-pass" } }),
      ).toEqual({ id: itemId });
      expect(workerBodies.findLast((b) => b.path === path)?.body).toEqual({
        teammateIds: null,
        secret: { password: "made-up-pass" },
      });
      await api.vault.patch({ itemId, name: "  GitHub work " });
      expect(workerBodies.findLast((b) => b.path === path)?.body).toEqual({ name: "GitHub work" });

      // Nothing to change is refused before the worker hears of it.
      const before = workerBodies.length;
      await expect(api.vault.patch({ itemId, secret: {} })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "Say what to change.",
      });
      // Nor does a secret left empty, which keeps what's saved.
      await expect(api.vault.patch({ itemId, secret: { password: "" } })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "Say what to change.",
      });
      expect(workerBodies.length).toBe(before);

      // An item deleted meanwhile keeps the worker's words.
      answers.set(path, {
        status: 404,
        body: { error: "That item is no longer in the vault.", code: "NOT_FOUND" },
      });
      await expect(api.vault.patch({ itemId, name: "Gone" })).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "That item is no longer in the vault.",
      });
    } finally {
      answers.clear();
    }
  });

  it("changes nothing when the worker is from before patch, never saving the whole item", async () => {
    const itemId = randomUUID();
    const path = `/internal/vault/${itemId}/patch`;
    answers.set(path, { status: 404, body: { error: "not found", code: "NOT_FOUND" } });
    try {
      const before = workerBodies.length;
      await expect(api.vault.patch({ itemId, name: "Renamed" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "open-bot is finishing an update, so nothing changed. Try again in a minute.",
      });
      expect(workerBodies.slice(before).map((b) => b.path)).toEqual([path]);
    } finally {
      answers.clear();
    }
  });

  const login = {
    kind: "login" as const,
    name: " GitHub ",
    domain: "github.com",
    teammateIds: null,
    secret: { username: "alex", password: "made-up-pass" },
  };

  it("adds a new item under the client's id, and says a reused id is one", async () => {
    const id = randomUUID();
    const path = "/internal/vault/create";
    answers.set(path, { status: 200, body: { id, created: false } });
    try {
      expect(await api.vault.create({ ...login, id })).toEqual({ id, created: false });
      expect(workerBodies.findLast((b) => b.path === path)?.body).toEqual({
        ...login,
        id,
        name: "GitHub",
      });
      answers.set(path, {
        status: 409,
        body: { error: "That vault id was already used for something else.", code: "CONFLICT" },
      });
      await expect(api.vault.create({ ...login, id })).rejects.toMatchObject({
        code: "CONFLICT",
        message: "That vault id was already used for something else.",
      });
    } finally {
      answers.clear();
    }
  });

  it("adds nothing when the worker is from before create, never saving it without its id", async () => {
    const path = "/internal/vault/create";
    answers.set(path, { status: 404, body: { error: "not found", code: "NOT_FOUND" } });
    try {
      const before = workerBodies.length;
      await expect(api.vault.create({ ...login, id: randomUUID() })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "open-bot is finishing an update, so nothing changed. Try again in a minute.",
      });
      expect(workerBodies.slice(before).map((b) => b.path)).toEqual([path]);
    } finally {
      answers.clear();
    }
  });
});
