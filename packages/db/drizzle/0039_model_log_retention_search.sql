ALTER TABLE "settings" ADD COLUMN "model_log_retention_days" integer;--> statement-breakpoint
ALTER TABLE "codex_events" ADD COLUMN "bodies_expired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "model_requests" ADD COLUMN "bodies_expired_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "runs_created_idx" ON "runs" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "codex_events_completed_idx" ON "codex_events" USING btree ("at") WHERE "codex_events"."method" = 'item/completed';--> statement-breakpoint
CREATE INDEX "codex_events_unexpired_idx" ON "codex_events" USING btree ("at") WHERE "codex_events"."bodies_expired_at" is null;--> statement-breakpoint
-- What text search reads of a blob: its JSON string values, decoded (so "a\nb" is two words),
-- without object keys, the values of structural fields (type, role, status, ids) or encrypted
-- reasoning. A blob jsonb can't read, or one over a million characters, is read as text with its
-- escapes undone instead, so indexing never fails a write. Either way only the first 100,000
-- characters count (`MODEL_LOG_SEARCH_CHARS` in @open-bot/domain). The index and the search must
-- call it identically. It is left parallel unsafe: its exception handler starts a subtransaction.
CREATE OR REPLACE FUNCTION "model_blob_search_text"("content" text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  doc jsonb;
BEGIN
  IF length(content) <= 1000000 THEN
    BEGIN
      doc := content::jsonb;
    EXCEPTION WHEN others THEN
      doc := NULL;
    END;
  END IF;
  IF doc IS NULL THEN
    RETURN regexp_replace(
      regexp_replace(left(content, 100000), '\\(?:[nrtbf]|u[0-9a-fA-F]{4})', ' ', 'g'),
      '\\(.)', '\1', 'g');
  END IF;
  RETURN left(coalesce((
    SELECT string_agg(s, ' ') FROM (
      SELECT doc #>> '{}' AS s WHERE jsonb_typeof(doc) = 'string'
      UNION ALL
      SELECT f.value #>> '{}'
      FROM jsonb_path_query(doc, 'strict $.** ? (@.type() == "object")') AS o(obj),
        jsonb_each(o.obj) AS f
      WHERE jsonb_typeof(f.value) = 'string'
        AND f.key NOT IN ('type', 'role', 'status', 'id', 'call_id', 'encrypted_content')
      UNION ALL
      SELECT e.value #>> '{}'
      FROM jsonb_path_query(doc, 'strict $.** ? (@.type() == "array")') AS a(arr),
        jsonb_array_elements(a.arr) AS e
      WHERE jsonb_typeof(e.value) = 'string'
    ) strings
    WHERE s !~ '^gAAAA'), ''), 100000);
END
$$;--> statement-breakpoint
-- A blob's JSON as jsonb, or null when jsonb refuses it (a NUL kept as \u0000, a lone surrogate),
-- so one such blob never fails a query that reads many.
CREATE OR REPLACE FUNCTION "model_blob_jsonb"("content" text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
  RETURN content::jsonb;
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE INDEX "model_blobs_search_idx" ON "model_blobs" USING gin (to_tsvector('simple', model_blob_search_text("content")));--> statement-breakpoint
CREATE INDEX "model_requests_model_idx" ON "model_requests" USING btree ("model","started_at");--> statement-breakpoint
CREATE INDEX "model_requests_instructions_idx" ON "model_requests" USING btree ("instructions_hash");--> statement-breakpoint
CREATE INDEX "model_requests_tools_idx" ON "model_requests" USING btree ("tools_hash");--> statement-breakpoint
CREATE INDEX "model_requests_unexpired_idx" ON "model_requests" USING btree ("started_at") WHERE "model_requests"."bodies_expired_at" is null;--> statement-breakpoint
CREATE INDEX "model_requests_response_search_idx" ON "model_requests" USING gin (to_tsvector('simple', left(coalesce("response_text", ''), 100000)));