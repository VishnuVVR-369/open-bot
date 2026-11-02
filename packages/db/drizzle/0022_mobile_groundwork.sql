CREATE TABLE "message_dispatches" (
	"message_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_dispatches_message_id_bot_id_pk" PRIMARY KEY("message_id","bot_id")
);
--> statement-breakpoint
CREATE TABLE "native_push_devices" (
	"token" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"device" text DEFAULT '' NOT NULL,
	"last_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "client_id" uuid;--> statement-breakpoint
-- Messages saved before this were all dispatched already; only new ones start out pending.
ALTER TABLE "messages" ADD COLUMN "dispatch_status" text DEFAULT 'dispatched' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "dispatch_status" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "message_dispatches" ADD CONSTRAINT "message_dispatches_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_dispatches" ADD CONSTRAINT "message_dispatches_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_client_id_unique" ON "messages" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "messages_pending_dispatch_idx" ON "messages" USING btree ("created_at") WHERE "messages"."dispatch_status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "runs_user_message_unique" ON "runs" USING btree ("message_id","bot_id") WHERE "runs"."trigger" = 'user' and "runs"."message_id" is not null;