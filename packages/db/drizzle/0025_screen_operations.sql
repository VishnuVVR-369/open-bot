CREATE TABLE "screen_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"takeover_id" uuid,
	"screen_id" uuid,
	"status" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "takeover_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"continuation_run_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "screen_operations" ADD CONSTRAINT "screen_operations_takeover_id_desktop_takeovers_id_fk" FOREIGN KEY ("takeover_id") REFERENCES "public"."desktop_takeovers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screen_operations" ADD CONSTRAINT "screen_operations_screen_id_bots_id_fk" FOREIGN KEY ("screen_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "takeover_deliveries" ADD CONSTRAINT "takeover_deliveries_id_desktop_takeovers_id_fk" FOREIGN KEY ("id") REFERENCES "public"."desktop_takeovers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "screen_operations_status_idx" ON "screen_operations" USING btree ("status");