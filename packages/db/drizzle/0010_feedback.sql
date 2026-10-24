CREATE TABLE "lessons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"run_id" uuid,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_threads" ADD COLUMN "lessons_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "lessons_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "redo_of_run_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "rating" text;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lessons_bot_idx" ON "lessons" USING btree ("bot_id","created_at");--> statement-breakpoint
CREATE INDEX "lessons_run_idx" ON "lessons" USING btree ("run_id");