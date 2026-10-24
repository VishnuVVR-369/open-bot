DROP INDEX "takeovers_status_idx";--> statement-breakpoint
ALTER TABLE "desktop_takeovers" ADD COLUMN "screen_id" uuid;--> statement-breakpoint
ALTER TABLE "desktop_takeovers" ADD CONSTRAINT "desktop_takeovers_screen_id_bots_id_fk" FOREIGN KEY ("screen_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "takeovers_status_idx" ON "desktop_takeovers" USING btree ("status","screen_id");--> statement-breakpoint
UPDATE "desktop_takeovers" SET "screen_id" = "requested_by_bot_id" WHERE "screen_id" IS NULL;--> statement-breakpoint
UPDATE "desktop_takeovers" SET "status" = 'ended', "ended_at" = now(), "end_reason" = 'handed_back' WHERE "status" = 'active' AND "screen_id" IS NULL;
