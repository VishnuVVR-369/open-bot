-- The agent tools were renamed from "bot" to "teammate" (create_bot to create_teammate, bot_id to
-- teammate_id, ...). An approval still open, or approved and not yet used, holds the tool call it
-- covers in payload.operation, and payload.operationKey hashes that call the way
-- configurationRevision() (packages/db/src/configuration.ts) does: sha256 of JSON with sorted keys.
-- This rewrites those calls to the new names and hashes them again, so the follow-up run asks for the
-- renamed call and its repeat matches the approval. Approvals already used or decided against are
-- history and stay as they are. Running it again changes nothing.
CREATE FUNCTION pg_temp.canonical_json(value jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      RETURN '{' || coalesce((
        SELECT string_agg(to_json(entry.key)::text || ':' || pg_temp.canonical_json(entry.value), ',' ORDER BY entry.key COLLATE "C")
        FROM jsonb_each(value) AS entry
      ), '') || '}';
    WHEN 'array' THEN
      RETURN '[' || coalesce((
        SELECT string_agg(pg_temp.canonical_json(item.value), ',' ORDER BY item.position)
        FROM jsonb_array_elements(value) WITH ORDINALITY AS item(value, position)
      ), '') || ']';
    WHEN 'string' THEN
      RETURN to_json(value #>> '{}')::text;
    ELSE
      RETURN value::text;
  END CASE;
END;
$$;--> statement-breakpoint
WITH renamed AS (
  SELECT
    id,
    jsonb_build_object(
      'tool',
      CASE payload #>> '{operation,tool}'
        WHEN 'create_bot' THEN 'create_teammate'
        WHEN 'update_bot' THEN 'update_teammate'
        WHEN 'set_bot_connection' THEN 'set_teammate_connection'
        ELSE payload #>> '{operation,tool}'
      END,
      'arguments',
      CASE
        WHEN (payload #> '{operation,arguments}') ? 'bot_id' THEN
          ((payload #> '{operation,arguments}') - 'bot_id')
            || jsonb_build_object('teammate_id', payload #> '{operation,arguments,bot_id}')
        ELSE payload #> '{operation,arguments}'
      END
    ) AS operation
  FROM approvals
  WHERE kind = 'action'
    AND status IN ('pending', 'approved')
    AND coalesce(payload ->> 'consumed', 'false') = 'false'
    AND jsonb_typeof(payload #> '{operation,arguments}') = 'object'
    AND (
      payload #>> '{operation,tool}' IN ('create_bot', 'update_bot', 'set_bot_connection')
      OR (payload #> '{operation,arguments}') ? 'bot_id'
    )
)
UPDATE approvals
SET payload = approvals.payload || jsonb_build_object(
  'operation', renamed.operation,
  'operationKey', encode(sha256(convert_to(pg_temp.canonical_json(renamed.operation), 'UTF8')), 'hex')
)
FROM renamed
WHERE approvals.id = renamed.id;--> statement-breakpoint
DROP FUNCTION pg_temp.canonical_json(jsonb);
