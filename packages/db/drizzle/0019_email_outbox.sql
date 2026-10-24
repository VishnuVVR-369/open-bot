ALTER TABLE "emails" ADD COLUMN "status" text DEFAULT 'received' NOT NULL;--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "reply_to_id" uuid;--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "approval_id" uuid;--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "chat_id" uuid;--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "item_id" text;--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;