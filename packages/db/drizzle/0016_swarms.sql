CREATE TABLE "swarm_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"swarm_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"instructions" text NOT NULL,
	"chat_id" uuid,
	"run_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "swarms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"item_id" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "screen_id" uuid;--> statement-breakpoint
ALTER TABLE "swarm_tasks" ADD CONSTRAINT "swarm_tasks_swarm_id_swarms_id_fk" FOREIGN KEY ("swarm_id") REFERENCES "public"."swarms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_tasks" ADD CONSTRAINT "swarm_tasks_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_tasks" ADD CONSTRAINT "swarm_tasks_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarms" ADD CONSTRAINT "swarms_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarms" ADD CONSTRAINT "swarms_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarms" ADD CONSTRAINT "swarms_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "swarm_tasks_swarm_idx" ON "swarm_tasks" USING btree ("swarm_id","position");--> statement-breakpoint
CREATE INDEX "swarms_bot_idx" ON "swarms" USING btree ("bot_id","created_at");