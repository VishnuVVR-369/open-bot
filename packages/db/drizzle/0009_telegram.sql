CREATE TABLE "telegram" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"bot_username" text,
	"chat_id" text,
	"linked_name" text,
	"link_code" text,
	"link_code_expires_at" timestamp with time zone,
	"update_offset" bigint DEFAULT 0 NOT NULL,
	"last_chat_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_messages" (
	"telegram_chat_id" text NOT NULL,
	"telegram_message_id" bigint NOT NULL,
	"chat_id" uuid,
	"message_id" uuid,
	"approval_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_messages_telegram_chat_id_telegram_message_id_pk" PRIMARY KEY("telegram_chat_id","telegram_message_id")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "via" text DEFAULT 'app' NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram" ADD CONSTRAINT "telegram_last_chat_id_chats_id_fk" FOREIGN KEY ("last_chat_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD CONSTRAINT "telegram_messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD CONSTRAINT "telegram_messages_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD CONSTRAINT "telegram_messages_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "telegram_messages_message_idx" ON "telegram_messages" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "telegram_messages_approval_idx" ON "telegram_messages" USING btree ("approval_id");