ALTER TABLE "bot_threads" ADD COLUMN "profile_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "about_me" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "about_me_updated_at" timestamp with time zone;