ALTER TABLE "schedules" ADD COLUMN "check_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Before this, the check-in was found by its title and quiet flag. Each teammate's first such
-- routine (an enabled one over a paused one) becomes its marked check-in; any others stay as
-- ordinary routines.
UPDATE "schedules" SET "check_in" = true WHERE "id" IN (
  SELECT DISTINCT ON ("teammate_id") "id" FROM "schedules"
  WHERE "title" = 'Daily check-in' AND "quiet" AND "kind" = 'cron'
  ORDER BY "teammate_id", "enabled" DESC, "created_at" ASC
);--> statement-breakpoint
CREATE UNIQUE INDEX "schedules_check_in_idx" ON "schedules" USING btree ("teammate_id") WHERE "schedules"."check_in";
