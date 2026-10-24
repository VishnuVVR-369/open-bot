CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"name" text NOT NULL,
	"transport" text NOT NULL,
	"url" text,
	"command" text,
	"args" text[] DEFAULT '{}'::text[] NOT NULL,
	"encrypted" text,
	"secret_names" text[] DEFAULT '{}'::text[] NOT NULL,
	"bot_ids" uuid[],
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_threads" ADD COLUMN "connections_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "connections_name_unique" ON "connections" USING btree ("name");