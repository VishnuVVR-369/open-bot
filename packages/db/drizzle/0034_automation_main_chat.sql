CREATE TABLE "chat_lane_threads" (
	"chat_id" uuid NOT NULL,
	"teammate_id" uuid NOT NULL,
	"lane" text NOT NULL,
	"codex_thread_id" text NOT NULL,
	"memory_generation" text DEFAULT '' NOT NULL,
	"tools_version" integer DEFAULT 0 NOT NULL,
	"tools_revision" text,
	"auth_mode" text DEFAULT 'plan' NOT NULL,
	"configuration_key" text DEFAULT '' NOT NULL,
	"profile_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lessons_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_lane_threads_chat_id_teammate_id_lane_pk" PRIMARY KEY("chat_id","teammate_id","lane")
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "lane" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "quiet" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "passed_on_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chat_lane_threads" ADD CONSTRAINT "chat_lane_threads_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_lane_threads" ADD CONSTRAINT "chat_lane_threads_teammate_id_bots_id_fk" FOREIGN KEY ("teammate_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;