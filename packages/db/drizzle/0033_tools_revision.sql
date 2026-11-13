ALTER TABLE "bot_threads" ALTER COLUMN "tools_version" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "bot_threads" ADD COLUMN "tools_revision" text;