import { describe, expect, it } from "vitest";
import { createHttpServer, type HttpDeps } from "../../http";
import { toolsEnabled, toolHarness, toolSuiteName } from "../../testing/tools";

describe.skipIf(!toolsEnabled)(toolSuiteName, () => {
  const { ctx, service } = toolHarness();

  it("uses the same service for authenticated UI create/update routes and rejects stale UI edits", async () => {
    const server = createHttpServer({ ctx, teammates: service } as unknown as HttpDeps);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No server port");
      const endpoint = `http://127.0.0.1:${address.port}/internal/teammates`;
      expect((await fetch(endpoint, { method: "POST" })).status).toBe(401);
      const headers = {
        "x-worker-secret": "test-worker-secret",
        "content-type": "application/json",
      };
      expect(
        (
          await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({ template_id: "unknown" }),
          })
        ).status,
      ).toBe(400);
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "UI teammate", role: "assistant" }),
      });
      expect(response.status).toBe(200);
      const created = (await response.json()) as { teammateId: string; revision: string };
      const body = JSON.stringify({
        changes: { name: "Edited" },
        expected_revision: created.revision,
      });
      expect(
        (await fetch(`${endpoint}/${created.teammateId}`, { method: "POST", headers, body }))
          .status,
      ).toBe(200);
      expect(
        (await fetch(`${endpoint}/${created.teammateId}`, { method: "POST", headers, body }))
          .status,
      ).toBe(409);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
