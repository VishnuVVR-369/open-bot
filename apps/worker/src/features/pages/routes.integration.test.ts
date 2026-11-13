import { describe, expect, it } from "vitest";
import { rpcEnabled, rpcHarness, failure, ID } from "../../testing/rpc";

describe.skipIf(!rpcEnabled)("worker internal API, end to end", () => {
  const h = rpcHarness();
  const { worker } = h;

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
});
