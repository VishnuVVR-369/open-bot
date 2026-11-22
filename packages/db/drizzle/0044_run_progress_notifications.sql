CREATE TABLE "run_progress_notifications" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"shown_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "native_push_devices" ADD COLUMN "registration" text;--> statement-breakpoint
ALTER TABLE "run_progress_notifications" ADD CONSTRAINT "run_progress_notifications_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;