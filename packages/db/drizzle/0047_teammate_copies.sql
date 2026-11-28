CREATE TABLE "teammate_copies" (
	"teammate_id" uuid PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL,
	"copy_memory" boolean NOT NULL,
	"memory_copied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "teammate_copies" ADD CONSTRAINT "teammate_copies_teammate_id_teammates_id_fk" FOREIGN KEY ("teammate_id") REFERENCES "public"."teammates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teammate_copies" ADD CONSTRAINT "teammate_copies_source_id_teammates_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."teammates"("id") ON DELETE cascade ON UPDATE no action;