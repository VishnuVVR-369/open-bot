import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Drizzle applies a migration only when its journal time is later than the last one the database
// applied. A migration regenerated under one stacked after it (so with a later time) would be
// skipped on every database that already has the earlier one, while a fresh database, which
// every integration test uses, applies both. So the journal's times must only grow, and each
// snapshot must follow the one before it.

const MIGRATIONS = join(import.meta.dirname, "..", "drizzle");

type Journal = { entries: { idx: number; when: number; tag: string }[] };
type Snapshot = { id: string; prevId: string };

const journal = JSON.parse(
  readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8"),
) as Journal;
const snapshot = (idx: number) =>
  JSON.parse(
    readFileSync(join(MIGRATIONS, "meta", `${String(idx).padStart(4, "0")}_snapshot.json`), "utf8"),
  ) as Snapshot;

describe("the migration journal", () => {
  it("lists migrations in order, each later than the one before", () => {
    journal.entries.forEach((entry, index) => {
      expect(entry.idx).toBe(index);
      if (index === 0) return;
      const previous = journal.entries[index - 1]!;
      expect(entry.when, `${entry.tag} must be later than ${previous.tag}`).toBeGreaterThan(
        previous.when,
      );
    });
  });

  it("chains the last migration's snapshot to the one before it", () => {
    const last = journal.entries.at(-1)!.idx;
    expect(snapshot(last).prevId).toBe(snapshot(last - 1).id);
  });
});
