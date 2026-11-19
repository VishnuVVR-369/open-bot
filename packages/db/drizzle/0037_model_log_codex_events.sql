CREATE TABLE "codex_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"codex_thread_id" text,
	"codex_turn_id" text,
	"item_id" text,
	"sequence" bigint NOT NULL,
	"direction" text NOT NULL,
	"kind" text NOT NULL,
	"method" text NOT NULL,
	"rpc_id" text,
	"payload" jsonb,
	"delta_counts" jsonb,
	"at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "codex_events_direction_check" CHECK ("codex_events"."direction" in ('to_codex','from_codex')),
	CONSTRAINT "codex_events_kind_check" CHECK ("codex_events"."kind" in ('request','response','notification'))
);
--> statement-breakpoint
CREATE TABLE "model_tool_calls" (
	"request_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"call_id" text,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"namespace" text,
	"arguments" text,
	CONSTRAINT "model_tool_calls_request_id_position_pk" PRIMARY KEY("request_id","position")
);
--> statement-breakpoint
CREATE TABLE "run_turns" (
	"codex_thread_id" text NOT NULL,
	"codex_turn_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"access_mode" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	CONSTRAINT "run_turns_codex_thread_id_codex_turn_id_pk" PRIMARY KEY("codex_thread_id","codex_turn_id"),
	CONSTRAINT "run_turns_access_mode_check" CHECK ("run_turns"."access_mode" in ('plan','api_key'))
);
--> statement-breakpoint
ALTER TABLE "model_log_gaps" ADD COLUMN "codex_events" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_log_gaps" ADD COLUMN "run_turns" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "codex_events" ADD CONSTRAINT "codex_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_tool_calls" ADD CONSTRAINT "model_tool_calls_request_id_model_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."model_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_turns" ADD CONSTRAINT "run_turns_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "codex_events_run_idx" ON "codex_events" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "codex_events_item_idx" ON "codex_events" USING btree ("codex_thread_id","item_id");--> statement-breakpoint
CREATE INDEX "codex_events_turn_idx" ON "codex_events" USING btree ("codex_thread_id","codex_turn_id");--> statement-breakpoint
CREATE INDEX "model_tool_calls_call_idx" ON "model_tool_calls" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "model_tool_calls_name_idx" ON "model_tool_calls" USING btree ("name");--> statement-breakpoint
CREATE INDEX "run_turns_run_idx" ON "run_turns" USING btree ("run_id","started_at");--> statement-breakpoint
-- Payloads are JSON read whole, like blobs: lz4 where the server has it, the default otherwise.
DO $$
BEGIN
	ALTER TABLE "codex_events" ALTER COLUMN "payload" SET COMPRESSION lz4;
EXCEPTION WHEN feature_not_supported OR invalid_parameter_value THEN
	RAISE NOTICE 'lz4 is not available, codex_events.payload keeps the default compression';
END $$;
