CREATE TABLE "model_blobs" (
	"hash" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_blobs_kind_check" CHECK ("model_blobs"."kind" in ('item','instructions','tools'))
);
--> statement-breakpoint
CREATE TABLE "model_log_gaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"first_at" timestamp with time zone NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	"requests" integer NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_request_items" (
	"request_id" uuid NOT NULL,
	"side" text NOT NULL,
	"position" integer NOT NULL,
	"blob_hash" text NOT NULL,
	CONSTRAINT "model_request_items_request_id_side_position_pk" PRIMARY KEY("request_id","side","position"),
	CONSTRAINT "model_request_items_side_check" CHECK ("model_request_items"."side" in ('input','output'))
);
--> statement-breakpoint
CREATE TABLE "model_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"route" text,
	"transport" text NOT NULL,
	"method" text NOT NULL,
	"endpoint" text NOT NULL,
	"codex_thread_id" text,
	"codex_turn_id" text,
	"request_kind" text,
	"teammate_id" uuid,
	"model" text,
	"response_id" text,
	"status" integer,
	"started_at" timestamp with time zone NOT NULL,
	"first_byte_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"input_tokens" bigint,
	"cached_input_tokens" bigint,
	"output_tokens" bigint,
	"reasoning_tokens" bigint,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"stop_reason" text,
	"error_type" text,
	"error_message" text,
	"request_headers" jsonb NOT NULL,
	"response_headers" jsonb,
	"rate_limit_headers" jsonb,
	"params" jsonb,
	"instructions_hash" text,
	"tools_hash" text,
	"response_text" text,
	"reasoning_summary" text,
	"raw_response" text,
	"request_bytes" bigint DEFAULT 0 NOT NULL,
	"response_bytes" bigint DEFAULT 0 NOT NULL,
	"parse_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_requests_source_check" CHECK ("model_requests"."source" in ('codex','memory')),
	CONSTRAINT "model_requests_route_check" CHECK ("model_requests"."route" in ('plan','api')),
	CONSTRAINT "model_requests_transport_check" CHECK ("model_requests"."transport" in ('http','websocket'))
);
--> statement-breakpoint
ALTER TABLE "model_request_items" ADD CONSTRAINT "model_request_items_request_id_model_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."model_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_request_items" ADD CONSTRAINT "model_request_items_blob_hash_model_blobs_hash_fk" FOREIGN KEY ("blob_hash") REFERENCES "public"."model_blobs"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_requests" ADD CONSTRAINT "model_requests_teammate_id_bots_id_fk" FOREIGN KEY ("teammate_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_requests" ADD CONSTRAINT "model_requests_instructions_hash_model_blobs_hash_fk" FOREIGN KEY ("instructions_hash") REFERENCES "public"."model_blobs"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_requests" ADD CONSTRAINT "model_requests_tools_hash_model_blobs_hash_fk" FOREIGN KEY ("tools_hash") REFERENCES "public"."model_blobs"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_request_items_blob_idx" ON "model_request_items" USING btree ("blob_hash");--> statement-breakpoint
CREATE INDEX "model_requests_turn_idx" ON "model_requests" USING btree ("codex_thread_id","codex_turn_id");--> statement-breakpoint
CREATE INDEX "model_requests_started_idx" ON "model_requests" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "model_requests_teammate_idx" ON "model_requests" USING btree ("teammate_id","started_at");--> statement-breakpoint
-- Blobs are mostly long JSON text read whole: lz4 compresses them faster than the default pglz.
-- A server built without lz4 refuses it, and keeps the default instead of failing the migration.
DO $$
BEGIN
	ALTER TABLE "model_blobs" ALTER COLUMN "content" SET COMPRESSION lz4;
EXCEPTION WHEN feature_not_supported OR invalid_parameter_value THEN
	RAISE NOTICE 'lz4 is not available, model_blobs.content keeps the default compression';
END $$;
