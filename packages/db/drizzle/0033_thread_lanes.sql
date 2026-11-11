ALTER TABLE "bot_threads" ADD COLUMN "lane" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "lane" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_threads_lane_unique" ON "bot_threads" USING btree ("chat_id","bot_id","lane");