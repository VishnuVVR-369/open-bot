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

  it("confirms a teammate's suggested memory", async () => {
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
      { kind: "bot", botId: ids.teammate, runId: ids.run, verified: false }, // vocabulary: allow
    );
    expect(suggested.state).toBe("candidate");
    const confirmed = await api.memory.confirm({
      id: suggested.id,
      expectedRevision: suggested.revision,
    });
    expect(confirmed.state).toBe("active");
  });
});
