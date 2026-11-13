import type { ApiClient } from "@open-bot/api";
import { beforeAll, describe, expect, it } from "vitest";
import { apiHarness, apiTestUrl } from "@/test/api/harness";
import { randomUUID } from "node:crypto";

// Keep the original suite name so full test names remain comparable across the move.
describe.skipIf(!apiTestUrl)("API reads, end to end", () => {
  const harness = apiHarness();
  const { database, ids, workerBodies, answers } = harness;
  let api: ApiClient;
  beforeAll(() => {
    api = harness.api;
  });

  it("passes connection changes to the worker, which owns them, and its refusals through", async () => {
    const connectionId = randomUUID();
    const server = {
      id: null,
      label: "Linear",
      transport: "http" as const,
      url: "https://mcp.linear.test/mcp",
      command: "",
      args: "",
      secrets: "Authorization: Bearer abc",
      teammateIds: null,
    };
    const change = {
      connectionId,
      capabilities: ["read"],
      teammateIds: [ids.teammate],
      askBeforeActing: true,
    };
    const calls: [string, () => Promise<unknown>, unknown, { status: number; body: unknown }][] = [
      [
        "/internal/connections",
        () => api.connections.save(server),
        server,
        { status: 200, body: { id: connectionId } },
      ],
      [
        `/internal/connections/${connectionId}/enabled`,
        () => api.connections.setEnabled({ connectionId, enabled: false }),
        { enabled: false },
        { status: 200, body: { ok: true } },
      ],
      [
        `/internal/connections/${connectionId}/delete`,
        () => api.connections.remove({ connectionId }),
        {},
        { status: 200, body: { warning: "Google couldn't be reached." } },
      ],
      [
        `/internal/connections/${connectionId}/account`,
        () => api.accounts.update(change),
        { capabilities: ["read"], teammateIds: [ids.teammate], askBeforeActing: true },
        { status: 200, body: { needsConsent: true } },
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
      answers.set("/internal/connections", {
        status: 400,
        body: { error: "Give the command the computer runs.", code: "BAD_REQUEST" },
      });
      answers.set(`/internal/connections/${connectionId}/enabled`, {
        status: 404,
        body: { error: "That connection is gone.", code: "NOT_FOUND" },
      });
      await expect(
        api.connections.save({ ...server, transport: "stdio", command: "" }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "Give the command the computer runs.",
      });
      await expect(
        api.connections.setEnabled({ connectionId, enabled: true }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", message: "That connection is gone." });
    } finally {
      for (const [path] of calls) answers.delete(path);
    }
  });

  it("tests a connection from the computer, through the worker", async () => {
    const [docs] = await api.connections.list();
    const found = {
      ok: true,
      status: "connected",
      tools: [{ name: "search", description: "" }],
      error: null,
    };
    answers.set(`/internal/connections/${docs!.id}/test`, { status: 200, body: found });
    try {
      expect(await api.connections.test({ connectionId: docs!.id })).toEqual(found);
      const offline = "The computer is offline.";
      answers.set(`/internal/connections/${docs!.id}/test`, {
        status: 503,
        body: { error: offline },
      });
      await expect(api.connections.test({ connectionId: docs!.id })).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        status: 503,
        message: offline,
      });
    } finally {
      answers.clear();
    }
  });

  it("starts a Google sign-in for this session once your client is saved", async () => {
    const connect = {
      kind: "gmail" as const,
      capabilities: ["read"],
      teammateIds: null,
      accountId: null,
    };
    await expect(api.accounts.connect(connect)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Add your Google OAuth client first (Set up Google).",
    });
    await expect(
      api.accounts.saveClient({ provider: "google", clientId: "nope", clientSecret: "x" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("Google OAuth client ID"),
    });
    await api.accounts.saveClient({
      provider: "google",
      clientId: "1234-abc.apps.googleusercontent.com",
      clientSecret: "GOCSPX-secret-value",
    });
    const { url: signIn } = await api.accounts.connect(connect);
    expect(new URL(signIn).searchParams.get("client_id")).toBe(
      "1234-abc.apps.googleusercontent.com",
    );
    const s = await import("@open-bot/db");
    const states = await database.db
      .select({ sessionId: s.oauthStates.sessionId })
      .from(s.oauthStates);
    expect(states).toEqual([{ sessionId: "session-1" }]);
  });
});
