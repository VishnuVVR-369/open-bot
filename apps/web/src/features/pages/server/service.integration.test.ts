import { randomUUID } from "node:crypto";
import { testDatabase, testDatabaseServer } from "@open-bot/db/testing";
import { verifyPageVersion } from "@open-bot/domain/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const url = testDatabaseServer();

/**
 * The web app's reads of pages: listing, a page with its versions, links to open a version,
 * downloads and search. The worker publishes, pins and deletes pages (its own tests cover that);
 * here they're rows in the database, as the worker leaves them.
 */
describe.skipIf(!url)("pages, as the apps read them", () => {
  const database = testDatabase(url);
  const { pool, db } = database;
  let api: typeof import("./service");
  let schema: typeof import("@open-bot/db");
  let teammateId: string;

  beforeAll(async () => {
    await database.create();
    process.env.DATABASE_URL = database.url;
    process.env.WORKER_URL = "http://127.0.0.1:9";
    process.env.WORKER_SECRET = "pages-test-secret";
    process.env.NEXT_PUBLIC_WORKER_WS_URL = "ws://worker.test";
    api = await import("./service");
    schema = await import("@open-bot/db");
  });
  beforeEach(async () => {
    await pool.query("truncate pages, bots restart identity cascade"); // vocabulary: allow
    teammateId = randomUUID();
    const teammates = schema.bots; // vocabulary: allow
    await db.insert(teammates).values({
      id: teammateId,
      name: "Iris",
      slug: "iris",
      role: "Research",
      instructions: "Test",
      color: "#123456",
    });
  });
  afterAll(async () => {
    const { pool: appPool } = await import("@/lib/server/db");
    await appPool.end();
    await database.drop();
  });

  /** A page whose versions are these HTML files, oldest first, last updated at `updatedAt`. */
  async function page(
    title: string,
    versions: { html: string; text: string }[],
    { updatedAt, pinned = false }: { updatedAt: Date; pinned?: boolean },
  ) {
    // Where the worker keeps a teammate's pages on the computer.
    const sourcePath = `/home/bot/bots/iris/pages/${title.toLowerCase()}/index.html`; // vocabulary: allow
    const [row] = await db
      .insert(schema.pages)
      .values({ title, summary: "", sourcePath, botId: teammateId, pinned }) // vocabulary: allow
      .returning();
    const inserted = await db
      .insert(schema.pageVersions)
      .values(
        versions.map((version, index) => ({
          pageId: row!.id,
          number: index + 1,
          botId: teammateId, // vocabulary: allow
          title,
          html: version.html,
          text: version.text,
          size: version.html.length,
          sha256: "ab".repeat(32),
        })),
      )
      .returning();
    await pool.query(
      "update pages set current_version_id = $2, version_count = $3, updated_at = $4 where id = $1",
      [row!.id, inserted.at(-1)!.id, inserted.length, updatedAt],
    );
    return { id: row!.id, sourcePath, versions: inserted.map((version) => version.id) };
  }

  it("lists pinned pages first, then the most recently updated", async () => {
    const older = await page(
      "Caching",
      [
        { html: "<p>One</p>", text: "One" },
        { html: "<p>Two</p>", text: "Two" },
      ],
      { updatedAt: new Date("2026-11-01T10:00:00Z") },
    );
    const newer = await page("Eviction", [{ html: "<p>Two</p>", text: "Two" }], {
      updatedAt: new Date("2026-11-02T10:00:00Z"),
    });
    expect((await api.listPages()).map((listed) => listed.id)).toEqual([newer.id, older.id]);

    await pool.query("update pages set pinned = true where id = $1", [older.id]);
    const listed = await api.listPages();
    expect(listed.map((listed) => [listed.id, listed.pinned])).toEqual([
      [older.id, true],
      [newer.id, false],
    ]);
    // A listed page says which version is current and how many there are.
    expect(listed[0]).toMatchObject({ version: 2, versionCount: 2 });
    expect(listed[1]).toMatchObject({ version: 1, versionCount: 1 });
    expect(listed.every((page) => page.botId === teammateId)).toBe(true); // vocabulary: allow
  });

  it("opens a page with its versions, newest first, and links to one of them", async () => {
    const made = await page(
      "Caching",
      [
        { html: "<p>First</p>", text: "First" },
        { html: '<link href="/lib/kit@1/page.css"><p>Second</p>', text: "Second" },
      ],
      { updatedAt: new Date() },
    );
    const detail = await api.getPage(made.id);
    expect(detail).toMatchObject({ version: 2, versionCount: 2, sourcePath: made.sourcePath });
    expect(detail.versions.map((version) => version.number)).toEqual([2, 1]);

    const link = await api.openPage({ versionId: made.versions[0]!, theme: "dark", ask: true });
    const opened = new URL(link.url);
    expect(opened.pathname).toBe(`/v/${made.versions[0]}`);
    expect(opened.searchParams.get("theme")).toBe("dark");
    expect(opened.searchParams.get("ask")).toBe("1");
    expect(
      verifyPageVersion(
        made.versions[0]!,
        opened.searchParams.get("k")!,
        "dev-pages-secret-change-me-0123456789",
      ),
    ).toBe(true);

    // A download loads its libraries from the pages service.
    const file = await api.pageDownload(detail.versionId);
    expect(file?.html).toMatch(/href="http:\/\/127\.0\.0\.1:3400\/lib\/kit@1\/page\.css"/);
  });

  it("finds pages by title or by their latest version's text, from two letters", async () => {
    const caching = await page(
      "Caching",
      [
        { html: "<p>Eviction</p>", text: "Eviction" },
        { html: "<p>Second</p>", text: "Second" },
      ],
      { updatedAt: new Date() },
    );
    const eviction = await page("Eviction", [{ html: "<p>Policies</p>", text: "Policies" }], {
      updatedAt: new Date(),
    });
    expect((await api.searchPages("eviction")).map((found) => found.id)).toEqual([eviction.id]);
    expect((await api.searchPages("second")).map((found) => found.id)).toEqual([caching.id]);
    expect(await api.searchPages("e")).toEqual([]);
  });

  it("says a page was deleted once it's gone", async () => {
    const made = await page("Caching", [{ html: "<p>One</p>", text: "One" }], {
      updatedAt: new Date(),
    });
    await pool.query("delete from pages where id = $1", [made.id]);
    await expect(api.getPage(made.id)).rejects.toThrow("That page was deleted.");
    await expect(api.openPage({ versionId: made.versions[0]! })).rejects.toThrow("deleted");
    expect(await api.pageDownload(made.versions[0]!)).toBeNull();
  });
});
