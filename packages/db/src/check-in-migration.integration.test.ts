// Migration 0046 marks each teammate's daily check-in, which was found by its title and quiet flag
// before. The database is migrated up to 0045, schedules are saved as the old web and worker saved
// them, and then the real migrator applies the rest, as a deploy does.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase, testDatabaseServer } from "./testing";

const server = testDatabaseServer();
const database = testDatabase(server);
const { pool } = database;

const ADA = "00000000-0000-4000-8000-000000000001";
const BO = "00000000-0000-4000-8000-000000000002";
const CY = "00000000-0000-4000-8000-000000000003";

describe.skipIf(!server)("migration 0046: the daily check-in is marked", () => {
  beforeAll(async () => {
    await database.create({ through: "0045_run_task" });
    for (const [id, name] of [
      [ADA, "Ada"],
      [BO, "Bo"],
      [CY, "Cy"],
    ] as const)
      await pool.query(
        `insert into teammates (id, name, slug, role, color) values ($1, $2, $3, 'helper', '#4f46e5')`,
        [id, name, name.toLowerCase()],
      );
    const schedule = (
      teammate: string,
      title: string,
      opts: { quiet?: boolean; enabled?: boolean; kind?: "cron" | "once"; at?: string },
    ) =>
      pool.query(
        `insert into schedules (teammate_id, title, prompt, kind, cron, run_at, timezone, enabled, quiet, created_by, created_at)
         values ($1, $2, 'Look around', $3, $4, $5, 'UTC', $6, $7, 'user', $8)`,
        [
          teammate,
          title,
          opts.kind ?? "cron",
          (opts.kind ?? "cron") === "cron" ? "0 9 * * *" : null,
          opts.kind === "once" ? "2099-01-01T09:00:00Z" : null,
          opts.enabled ?? true,
          opts.quiet ?? true,
          opts.at ?? "2026-11-01T00:00:00Z",
        ],
      );
    // Ada turned hers off, then on again, which added a second one: the enabled one is hers.
    await schedule(ADA, "Daily check-in", { enabled: false, at: "2026-11-01T00:00:00Z" });
    await schedule(ADA, "Daily check-in", { enabled: true, at: "2026-11-02T00:00:00Z" });
    // Bo has a loud routine of the same name, and a reminder; neither is a check-in.
    await schedule(BO, "Daily check-in", { quiet: false });
    await schedule(BO, "Daily check-in", { kind: "once" });
    // Cy's two paused ones: the first made is the check-in.
    await schedule(CY, "Daily check-in", { enabled: false, at: "2026-11-01T00:00:00Z" });
    await schedule(CY, "Daily check-in", { enabled: false, at: "2026-11-03T00:00:00Z" });
    await database.migrate();
  });

  afterAll(() => database.drop());

  it("marks one check-in per teammate, preferring one that is on, then the first made", async () => {
    const { rows } = await pool.query<{
      teammate_id: string;
      enabled: boolean;
      created_at: Date;
      check_in: boolean;
    }>(
      `select teammate_id, enabled, created_at, check_in from schedules order by teammate_id, created_at`,
    );
    const marked = rows.filter((row) => row.check_in);
    expect(
      marked.map((row) => [row.teammate_id, row.enabled, row.created_at.toISOString()]),
    ).toEqual([
      [ADA, true, "2026-11-02T00:00:00.000Z"],
      [CY, false, "2026-11-01T00:00:00.000Z"],
    ]);
    expect(rows).toHaveLength(6);
  });

  it("refuses a second check-in for a teammate", async () => {
    await expect(
      pool.query(
        `insert into schedules (teammate_id, title, prompt, kind, cron, timezone, check_in, created_by)
         values ($1, 'Another', 'Look', 'cron', '0 9 * * *', 'UTC', true, 'user')`,
        [ADA],
      ),
    ).rejects.toThrow();
  });
});
