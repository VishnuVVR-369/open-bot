CREATE TABLE "account_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid,
	"account_id" uuid,
	"grant_revision" integer NOT NULL,
	"connection_revision" integer NOT NULL,
	"bot_id" uuid,
	"run_id" uuid,
	"chat_id" uuid,
	"item_id" text NOT NULL,
	"tool" text NOT NULL,
	"effect" text NOT NULL,
	"request" jsonb NOT NULL,
	"summary" text NOT NULL,
	"labels" jsonb NOT NULL,
	"preview" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"approval_id" uuid,
	"attempt" integer DEFAULT 0 NOT NULL,
	"provider_ref" jsonb,
	"result" jsonb,
	"error" text,
	"next_check_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"reported_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"kind" text NOT NULL,
	"private" boolean DEFAULT false NOT NULL,
	"action_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"oauth_client_id" uuid NOT NULL,
	"display" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"encrypted" text NOT NULL,
	"credential_version" integer DEFAULT 1 NOT NULL,
	"grant_revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"last_error" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"source" text NOT NULL,
	"client_id" text NOT NULL,
	"encrypted_secret" text,
	"hint" text,
	"issuer" text,
	"redirect_uri" text,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"state" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"verifier" text NOT NULL,
	"session_id" text NOT NULL,
	"purpose" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trigger_firings" (
	"trigger_id" uuid NOT NULL,
	"key" text NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trigger_firings_trigger_id_key_pk" PRIMARY KEY("trigger_id","key")
);
--> statement-breakpoint
ALTER TABLE "connections" ALTER COLUMN "transport" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "kind" text DEFAULT 'mcp' NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "capabilities" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "ask_before_acting" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "read_outside_data" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "query" text;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "lead_minutes" integer;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "cursor" text;--> statement-breakpoint
ALTER TABLE "account_actions" ADD CONSTRAINT "account_actions_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_actions" ADD CONSTRAINT "account_actions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_actions" ADD CONSTRAINT "account_actions_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_actions" ADD CONSTRAINT "account_actions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_actions" ADD CONSTRAINT "account_actions_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_resources" ADD CONSTRAINT "account_resources_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_resources" ADD CONSTRAINT "account_resources_action_id_account_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."account_actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_oauth_client_id_oauth_clients_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_firings" ADD CONSTRAINT "trigger_firings_trigger_id_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_actions_status_idx" ON "account_actions" USING btree ("status","next_check_at");--> statement-breakpoint
CREATE INDEX "account_actions_unreported_idx" ON "account_actions" USING btree ("finished_at") WHERE "account_actions"."reported_at" is null and "account_actions"."finished_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "account_actions_approval_unique" ON "account_actions" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "account_actions_connection_idx" ON "account_actions" USING btree ("connection_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "account_resources_unique" ON "account_resources" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_identity_unique" ON "accounts" USING btree ("provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_clients_identity_unique" ON "oauth_clients" USING btree ("provider","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_clients_current_unique" ON "oauth_clients" USING btree ("provider") WHERE "oauth_clients"."retired_at" is null;--> statement-breakpoint
CREATE INDEX "oauth_states_expires_idx" ON "oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "trigger_firings_created_idx" ON "trigger_firings" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connections_account_kind_unique" ON "connections" USING btree ("account_id","kind") WHERE "connections"."account_id" is not null;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_kind_shape" CHECK (("connections"."kind" = 'mcp' and "connections"."transport" is not null and "connections"."account_id" is null) or ("connections"."kind" <> 'mcp' and "connections"."transport" is null and "connections"."account_id" is not null));