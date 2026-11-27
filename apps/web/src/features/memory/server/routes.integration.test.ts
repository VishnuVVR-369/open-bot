import { randomUUID } from "node:crypto";
import type { ApiClient } from "@open-bot/api";
import { beforeAll, describe, expect, it } from "vitest";
import { apiHarness, apiTestUrl } from "@/test/api/harness";

// Keep the original suite name so full test names remain comparable across the move.
describe.skipIf(!apiTestUrl)("API reads, end to end", () => {
  const harness = apiHarness();
  const { ids, owned } = harness;
  let api: ApiClient;
  beforeAll(() => {
    api = harness.api;
  });

  it("saves, edits, restores and forgets a memory, refusing an edit to a stale revision", async () => {
    const saved = await api.memory.create({ ...owned(null), content: "Lives in Berlin" });
    expect(saved).toMatchObject({ saveOutcome: "created", revision: 1 });
    expect(await api.memory.create({ ...owned(null), content: "lives in  berlin" })).toMatchObject({
      id: saved.id,
      saveOutcome: "unchanged",
    });
    const edited = await api.memory.update({
      id: saved.id,
      expectedRevision: 1,
      ...owned(null),
      content: "Lives in Hamburg",
    });
    expect(edited.revision).toBe(2);
    await expect(
      api.memory.update({
        id: saved.id,
        expectedRevision: 1,
        ...owned(null),
        content: "Lives in Bonn",
      }),
    ).rejects.toMatchObject({ code: "STATE_CONFLICT", status: 409 });
    const restored = await api.memory.restore({ id: saved.id, expectedRevision: 2, revision: 1 });
    expect(restored).toMatchObject({ content: "Lives in Berlin", revision: 3 });
    await api.memory.forget({ id: saved.id, expectedRevision: 3 });
    expect(await api.memory.list({ ...owned(null), query: "Berlin" })).toEqual([]);
  });

  it("saves a memory under the client's id, so a retry after a lost answer adds nothing", async () => {
    const id = randomUUID();
    const saved = await api.memory.create({ ...owned(null), content: "Lives in Lisbon", id });
    expect(saved).toMatchObject({ id, saveOutcome: "created" });
    await api.memory.update({
      id,
      expectedRevision: 1,
      ...owned(null),
      content: "Lives in Porto",
    });
    expect(
      await api.memory.create({ ...owned(null), content: "Lives in Lisbon", id }),
    ).toMatchObject({ id, saveOutcome: "created", content: "Lives in Porto" });
    expect(await api.memory.list({ ...owned(null), query: "Lisbon" })).toEqual([]);
    // The id already names that memory, so other words under it aren't a retry.
    await expect(
      api.memory.create({ ...owned(null), content: "Lives in Faro", id }),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    await api.memory.forget({ id, expectedRevision: 2 });
    await expect(
      api.memory.create({ ...owned(null), content: "Lives in Lisbon", id }),
    ).rejects.toMatchObject({
      code: "STATE_CONFLICT",
      message: expect.stringMatching(/forgotten/),
    });
    expect(await api.memory.list({ ...owned(null), query: "Lisbon" })).toEqual([]);
  });

  it("reads one memory by id, with the chat that saved it, and none once it's forgotten", async () => {
    const { memory } = await import("@/features/memory/server");
    const saved = await memory.save(
      {
        ...owned(ids.teammate),
        kind: "preference",
        content: "Prefers window seats",
        key: null,
        pinned: false,
        expiresAt: null,
      },
      { kind: "teammate", teammateId: ids.teammate, runId: ids.run, verified: true },
    );
    expect(await api.memory.get({ memoryId: saved.id })).toMatchObject({
      id: saved.id,
      content: "Prefers window seats",
      revision: 1,
      source: { runId: ids.run, teammateId: ids.teammate, chatId: ids.chat },
    });
    await api.memory.forget({ id: saved.id, expectedRevision: 1 });
    await expect(api.memory.get({ memoryId: saved.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("confirms a teammate's suggested memory, answering with who saved it like a read", async () => {
    const { memory } = await import("@/features/memory/server");
    const suggested = await memory.save(
      {
        ...owned(ids.teammate),
        kind: "fact",
        content: "Has a dog named Rex",
        key: null,
        pinned: false,
        expiresAt: null,
      },
      { kind: "teammate", teammateId: ids.teammate, runId: ids.run, verified: false },
    );
    expect(suggested.state).toBe("candidate");
    const confirmed = await api.memory.confirm({
      id: suggested.id,
      expectedRevision: suggested.revision,
    });
    // A change answers with the memory as a read shows it, so the phone can show the answer as is.
    expect(confirmed).toMatchObject({
      state: "active",
      source: { runId: ids.run, teammateId: ids.teammate, chatId: ids.chat },
    });
  });
});
