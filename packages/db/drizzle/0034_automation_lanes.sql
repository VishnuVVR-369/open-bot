DROP INDEX "bot_threads_lane_unique";--> statement-breakpoint
ALTER TABLE "bot_threads" DROP CONSTRAINT "bot_threads_chat_id_bot_id_pk";--> statement-breakpoint
ALTER TABLE "bot_threads" ADD CONSTRAINT "bot_threads_chat_id_bot_id_lane_pk" PRIMARY KEY("chat_id","bot_id","lane");