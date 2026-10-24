CREATE TABLE "triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"prompt" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"url" text,
	"interval_minutes" integer,
	"look_for" text,
	"snapshot" text,
	"next_check_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"token" text,
	"last_fired_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "trigger_id" uuid;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "triggers_token_unique" ON "triggers" USING btree ("token");--> statement-breakpoint
CREATE INDEX "triggers_due_idx" ON "triggers" USING btree ("enabled","next_check_at");--> statement-breakpoint
CREATE INDEX "runs_trigger_idx" ON "runs" USING btree ("trigger_id","created_at");