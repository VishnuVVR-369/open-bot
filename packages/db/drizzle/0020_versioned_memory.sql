CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "memory_contexts" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"generation" text NOT NULL,
	"refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_embeddings" (
	"memory_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"model" text NOT NULL,
	"embedding" vector NOT NULL,
	CONSTRAINT "memory_embeddings_memory_id_model_pk" PRIMARY KEY("memory_id","model")
);
--> statement-breakpoint
CREATE TABLE "memory_generations" (
	"scope" text PRIMARY KEY NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_imports" (
	"key" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid,
	"kind" text DEFAULT 'fact' NOT NULL,
	"content" text NOT NULL,
	"key" text,
	"fingerprint" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"source" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"legacy_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_items_legacy_key_unique" UNIQUE("legacy_key"),
	CONSTRAINT "memory_kind_check" CHECK ("memory_items"."kind" in ('fact','preference','lesson','note')),
	CONSTRAINT "memory_state_check" CHECK ("memory_items"."state" in ('active','candidate','deleted')),
	CONSTRAINT "memory_revision_positive" CHECK ("memory_items"."revision" > 0),
	CONSTRAINT "memory_deleted_empty" CHECK ("memory_items"."state" <> 'deleted' or "memory_items"."content" = '')
);
--> statement-breakpoint
CREATE TABLE "memory_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"memory_id" uuid,
	"revision" integer,
	"run_id" uuid,
	"dedupe_key" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_jobs_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "memory_job_kind_check" CHECK ("memory_jobs"."kind" in ('embed','extract'))
);
--> statement-breakpoint
CREATE TABLE "memory_revisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"memory_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"content" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"source" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_usage" (
	"day" date PRIMARY KEY NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_threads" ADD COLUMN "memory_generation" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_contexts" ADD CONSTRAINT "memory_contexts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_contexts" ADD CONSTRAINT "memory_contexts_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_memory_id_memory_items_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memory_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_jobs" ADD CONSTRAINT "memory_jobs_memory_id_memory_items_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memory_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_jobs" ADD CONSTRAINT "memory_jobs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revisions_memory_id_memory_items_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memory_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_items_scope_state" ON "memory_items" USING btree ("bot_id","state");--> statement-breakpoint
CREATE INDEX "memory_items_search" ON "memory_items" USING gin (to_tsvector('english', "content" || ' ' || regexp_replace(coalesce("key", ''),'[^[:alnum:]]+',' ','g')));
CREATE UNIQUE INDEX "memory_items_live_fingerprint" ON "memory_items" USING btree (coalesce("bot_id"::text, 'shared'),"fingerprint") WHERE "memory_items"."state" <> 'deleted';--> statement-breakpoint
CREATE UNIQUE INDEX "memory_items_live_topic" ON "memory_items" USING btree (coalesce("bot_id"::text, 'shared'),"key") WHERE "memory_items"."state" = 'active' and "memory_items"."key" is not null;--> statement-breakpoint
CREATE INDEX "memory_jobs_pending" ON "memory_jobs" USING btree ("available_at") WHERE "memory_jobs"."completed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_revisions_version" ON "memory_revisions" USING btree ("memory_id","revision");