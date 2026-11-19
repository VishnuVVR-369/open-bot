-- usage_entries is retired. A request the worker counts is marked on model_requests
-- (counts_usage), and what the previous workers wrote to usage_entries is the legacy totals
-- (migration 0040). 0040's trigger copied every entry written since as it landed; the copy runs
-- once more here regardless, and then the table goes.
--
-- Deploy this only after 0040's worker is the one running: a worker that still writes entries
-- (one from before 0040, or a rollback to one) waits on these locks, then fails with 42P01 (no
-- such table) once this commits.
--
-- Every lock this migration needs, taken together before anything else and held until it
-- commits, so no entry can be written between the copy and the drop, and never waited for while
-- holding one: each try asks for all of them without waiting (NOWAIT), and a try that can't have
-- one gives back the ones it got (its subtransaction rolls back) and tries again 50 ms later.
-- Dropping usage_entries also drops its foreign keys, which needs runs and bots too. The app's
-- own transactions take these tables in either order (a run's deletion writes runs, then its
-- usage_entries; a teammate's deletion writes bots, then its runs; a new run writes runs, then
-- its foreign key reads bots), so waiting for one while holding another could deadlock with them,
-- and the deadlock could abort this migration and the deploy. A migration that holds nothing
-- while it waits is never part of a deadlock. After two minutes without all of them it fails,
-- and the deploy stays on the previous commit.
-- Applied in the same run as 0040 (a database that skipped a deploy), 0040's locks are still
-- held here, so a transaction holding bots and waiting for runs can keep this from finishing:
-- it then fails after two minutes, as above, and the app's transaction goes on.
DO $$
DECLARE
  deadline timestamptz := clock_timestamp() + interval '2 minutes';
BEGIN
  LOOP
    BEGIN
      LOCK TABLE "usage_entries", "runs", "bots" IN ACCESS EXCLUSIVE MODE NOWAIT;
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > deadline THEN
        RAISE;
      END IF;
    END;
    PERFORM pg_sleep(0.05);
  END LOOP;
END
$$;--> statement-breakpoint
-- Each run's totals summed again from all of its entries, and deleted runs' entries under their
-- own keys, skipping keys already held (0040's copy, or the runs_keep_legacy_usage trigger).
SELECT copy_legacy_usage(NULL);--> statement-breakpoint
DROP TRIGGER "usage_entries_copy_legacy" ON "usage_entries";--> statement-breakpoint
DROP FUNCTION usage_entries_copy_legacy();--> statement-breakpoint
DROP FUNCTION copy_legacy_usage(uuid);--> statement-breakpoint
DROP TABLE "usage_entries" CASCADE;
