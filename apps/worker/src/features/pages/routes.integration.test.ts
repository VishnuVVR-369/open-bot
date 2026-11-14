import { pages } from "@open-bot/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { rpcEnabled, rpcHarness, failure, ID } from "../../testing/rpc";

describe.skipIf(!rpcEnabled)("worker internal API, end to end", () => {
  const h = rpcHarness();
  const { db, worker, teammateWithRun } = h;

  it("pages and uploads: publish with warnings, and a missing upload is a 404", async () => {
    expect(
      await worker.pages.publish({
        botId: ID,
        path: "/home/bot/shared/report.html",
        title: "Report",
      }),
    ).toEqual({ pageId: ID, versionId: ID, version: 1, warnings: ["No <title>."] });
    expect(await failure(worker.uploads.status({ uploadId: ID }))).toEqual({
      status: 404,
      message: "That upload isn't here.",
    });
  });
  describe("vault, page and notification writes", () => {
    it("pins and deletes a page, and says one that's gone is gone", async () => {
      const { created } = await teammateWithRun();
      const [page] = await db
        .insert(pages)
        .values({ title: "Trip plan", botId: created.id }) // vocabulary: allow
        .returning();
      await worker.pages.pin({ pageId: page!.id, pinned: true });
      const reload = async () => (await db.select().from(pages).where(eq(pages.id, page!.id)))[0];
      expect((await reload())!.pinned).toBe(true);
      await worker.pages.remove({ pageId: page!.id });
      expect(await reload()).toBeUndefined();
      expect(await failure(worker.pages.pin({ pageId: page!.id, pinned: false }))).toEqual({
        status: 404,
        message: "That page was deleted.",
      });
    });
  });
});
