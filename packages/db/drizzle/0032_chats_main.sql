ALTER TABLE "chats" ADD COLUMN "main" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chats_main_unique" ON "chats" USING btree ("bot_id") WHERE "chats"."main";--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_main_direct" CHECK (not "chats"."main" or "chats"."kind" = 'direct');--> statement-breakpoint
-- Each teammate's oldest open direct chat becomes its main chat, the one the app already opened for it.
UPDATE "chats" SET "main" = true WHERE "id" IN (
  SELECT DISTINCT ON ("bot_id") "id" FROM "chats"
  WHERE "kind" = 'direct' AND "archived_at" IS NULL AND "bot_id" IS NOT NULL
  ORDER BY "bot_id", "created_at", "id"
);
