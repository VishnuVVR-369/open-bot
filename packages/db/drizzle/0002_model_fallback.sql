ALTER TABLE "bot_threads" ADD COLUMN "auth_mode" text DEFAULT 'plan' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "plan_limited_until" timestamp with time zone;