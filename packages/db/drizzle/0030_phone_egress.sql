CREATE TABLE "egress_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"push_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "phone_egress" text DEFAULT 'fallback' NOT NULL;