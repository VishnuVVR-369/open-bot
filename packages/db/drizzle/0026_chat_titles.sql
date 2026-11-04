ALTER TABLE "chats" ADD COLUMN "titled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Every chat but a direct chat still named after its teammate already has a real title.
UPDATE "chats" SET "titled" = true
WHERE "kind" <> 'direct'
  OR "bot_id" IS NULL
  OR "title" <> (SELECT "name" FROM "bots" WHERE "bots"."id" = "chats"."bot_id");
