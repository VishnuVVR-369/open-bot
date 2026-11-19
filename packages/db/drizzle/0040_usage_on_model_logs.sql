-- Every lock this migration needs, taken together before anything else, and never waited for
-- while holding one: each try asks for all of them without waiting (NOWAIT), and a try that can't
-- have one gives back the ones it got (its subtransaction rolls back) and tries again 50 ms later.
-- The app's own transactions take these tables in either order (the previous worker writes a
-- usage_entries row, then its foreign keys read runs; a run's deletion writes runs, then its
-- usage_entries; the model log writer writes model_requests, then rows that name runs, then
-- model_log_gaps), so waiting for one while holding another could deadlock with them, and the
-- deadlock could abort this migration and the deploy. A migration that holds nothing while it
-- waits is never part of a deadlock. After two minutes without all of them it fails, and the
-- deploy stays on the previous commit.
-- usage_entries only in SHARE ROW EXCLUSIVE, so the previous worker's cap can still read it.
DO $$
DECLARE
  deadline timestamptz := clock_timestamp() + interval '2 minutes';
BEGIN
  LOOP
    BEGIN
      LOCK TABLE "usage_entries" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "model_requests", "runs", "model_log_gaps" IN ACCESS EXCLUSIVE MODE NOWAIT;
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
CREATE TABLE "legacy_deleted_run_usage" (
	"source_key" text PRIMARY KEY NOT NULL,
	"run_id" uuid,
	"teammate_id" uuid,
	"access_mode" text NOT NULL,
	"input_tokens" bigint NOT NULL,
	"cached_input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cost_micros" bigint NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "legacy_deleted_run_usage_access_mode_check" CHECK ("legacy_deleted_run_usage"."access_mode" in ('plan','api_key'))
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "legacy_plan_input_tokens" bigint;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "legacy_plan_cached_input_tokens" bigint;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "legacy_plan_output_tokens" bigint;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "legacy_plan_cost_micros" bigint;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "legacy_api_key_input_tokens" bigint;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "legacy_api_key_cached_input_tokens" bigint;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "legacy_api_key_output_tokens" bigint;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "legacy_api_key_cost_micros" bigint;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "legacy_usage_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_log_gaps" ADD COLUMN "api_requests" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_log_gaps" ADD COLUMN "api_cost_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_log_gaps" ADD COLUMN "api_requests_estimated" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_requests" ADD COLUMN "usage_estimated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "model_requests" ADD COLUMN "counts_usage" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "legacy_deleted_run_usage_at_idx" ON "legacy_deleted_run_usage" USING btree ("at");--> statement-breakpoint
CREATE INDEX "runs_legacy_usage_idx" ON "runs" USING btree ("legacy_usage_at") WHERE "runs"."legacy_usage_at" is not null;--> statement-breakpoint
CREATE INDEX "model_requests_api_started_idx" ON "model_requests" USING btree ("started_at") WHERE "model_requests"."route" = 'api' and "model_requests"."counts_usage";--> statement-breakpoint
-- Usage moves onto the model logs. Each request counts through exactly one producer: a worker
-- that writes usage_entries counts its runs there, and those entries become the legacy totals
-- below; a worker that no longer does marks every request it logs (model_requests.counts_usage),
-- and only marked requests count. No clock decides it, so a deploy, a rollback to a worker that
-- writes usage_entries again, and a return all count each request once.
--
-- Entries such a worker writes after this migration (while this deploys, or after a rollback)
-- are copied as they are written, by the trigger below; the lock taken first (above) makes one
-- written while this runs wait until it commits, so none is missed.
-- Copies usage_entries onto the legacy totals: one run's entries (only_run), or with null
-- every run's plus the entries whose run was deleted. Each run's totals are summed again from
-- all of its entries, and a deleted run's entry keeps its key, so copying again adds nothing.
CREATE FUNCTION copy_legacy_usage(only_run uuid) RETURNS void
LANGUAGE sql AS $$
  UPDATE runs AS r SET
    legacy_plan_input_tokens = u.plan_input,
    legacy_plan_cached_input_tokens = u.plan_cached,
    legacy_plan_output_tokens = u.plan_output,
    legacy_plan_cost_micros = u.plan_cost,
    legacy_api_key_input_tokens = u.api_input,
    legacy_api_key_cached_input_tokens = u.api_cached,
    legacy_api_key_output_tokens = u.api_output,
    legacy_api_key_cost_micros = u.api_cost,
    legacy_usage_at = u.at
  FROM (
    SELECT run_id,
      sum(input_tokens) FILTER (WHERE auth_mode = 'plan') AS plan_input,
      sum(cached_input_tokens) FILTER (WHERE auth_mode = 'plan') AS plan_cached,
      sum(output_tokens) FILTER (WHERE auth_mode = 'plan') AS plan_output,
      sum(cost_micros) FILTER (WHERE auth_mode = 'plan') AS plan_cost,
      sum(input_tokens) FILTER (WHERE auth_mode = 'api_key') AS api_input,
      sum(cached_input_tokens) FILTER (WHERE auth_mode = 'api_key') AS api_cached,
      sum(output_tokens) FILTER (WHERE auth_mode = 'api_key') AS api_output,
      sum(cost_micros) FILTER (WHERE auth_mode = 'api_key') AS api_cost,
      -- The cap counted the API key entry in its own month; both were written as the run finished.
      coalesce(max(created_at) FILTER (WHERE auth_mode = 'api_key'), max(created_at)) AS at
    FROM usage_entries
    WHERE run_id IS NOT NULL AND (only_run IS NULL OR run_id = only_run)
    GROUP BY run_id
  ) AS u
  WHERE r.id = u.run_id;
  -- Entries whose run was deleted still count toward their month's cap and usage, with the run
  -- id their key names.
  INSERT INTO legacy_deleted_run_usage (
    source_key, run_id, teammate_id, access_mode,
    input_tokens, cached_input_tokens, output_tokens, cost_micros, at
  )
  SELECT idempotency_key,
    CASE WHEN idempotency_key ~ '^run:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:'
      THEN substring(idempotency_key FROM 5 FOR 36)::uuid END,
    bot_id, auth_mode,
    input_tokens, cached_input_tokens, output_tokens, cost_micros, created_at
  FROM usage_entries
  WHERE run_id IS NULL AND only_run IS NULL
  ON CONFLICT (source_key) DO NOTHING;
$$;--> statement-breakpoint
-- An entry written after this migration (by a worker that still writes usage_entries) is copied
-- at once. One without a run copies everything again, which adds only what is new.
CREATE FUNCTION usage_entries_copy_legacy() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM copy_legacy_usage(NEW.run_id);
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER usage_entries_copy_legacy AFTER INSERT ON "usage_entries"
FOR EACH ROW EXECUTE FUNCTION usage_entries_copy_legacy();--> statement-breakpoint
SELECT copy_legacy_usage(NULL);--> statement-breakpoint
-- A run deleted from now on takes its legacy totals into legacy_deleted_run_usage, under the
-- keys its entries have, as its usage_entries outlived it: this month's cap still counts them,
-- and copying the entries again (the migration that drops usage_entries does) adds nothing.
CREATE FUNCTION runs_keep_legacy_usage() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO legacy_deleted_run_usage (
    source_key, run_id, teammate_id, access_mode,
    input_tokens, cached_input_tokens, output_tokens, cost_micros, at
  )
  SELECT 'run:' || OLD.id || ':' || m.mode, OLD.id, OLD.bot_id, m.mode,
    m.input, coalesce(m.cached, 0), coalesce(m.output, 0), coalesce(m.cost, 0),
    OLD.legacy_usage_at
  FROM (VALUES
    ('plan', OLD.legacy_plan_input_tokens, OLD.legacy_plan_cached_input_tokens,
      OLD.legacy_plan_output_tokens, OLD.legacy_plan_cost_micros),
    ('api_key', OLD.legacy_api_key_input_tokens, OLD.legacy_api_key_cached_input_tokens,
      OLD.legacy_api_key_output_tokens, OLD.legacy_api_key_cost_micros)
  ) AS m (mode, input, cached, output, cost)
  WHERE m.input IS NOT NULL
  ON CONFLICT (source_key) DO NOTHING;
  RETURN OLD;
END
$$;--> statement-breakpoint
CREATE TRIGGER runs_keep_legacy_usage BEFORE DELETE ON "runs"
FOR EACH ROW WHEN (OLD.legacy_usage_at IS NOT NULL)
EXECUTE FUNCTION runs_keep_legacy_usage();
