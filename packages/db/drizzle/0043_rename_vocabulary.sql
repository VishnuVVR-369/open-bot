-- The last vocabulary rename (see the glossary in AGENTS.md): bot -> teammate, primary -> lead,
-- desktop takeover -> screen takeover, and the integrations' `accounts` -> `account_connections`
-- (Better Auth's `account` is sign-in and stays). Everything is renamed in place, never dropped and
-- made again, and the stored values that named a teammate "bot" are rewritten in the same
-- transaction. Each step does nothing when it already ran, and refuses a database that has
-- neither the old name nor the new one, so running it twice changes nothing.
CREATE FUNCTION pg_temp.rename_table(old_name text, new_name text) RETURNS void AS $$
BEGIN
  IF to_regclass(format('public.%I', new_name)) IS NOT NULL AND to_regclass(format('public.%I', old_name)) IS NULL THEN
    RETURN;
  END IF;
  EXECUTE format('ALTER TABLE public.%I RENAME TO %I', old_name, new_name);
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION pg_temp.rename_column(table_name text, old_name text, new_name text) RETURNS void AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = rename_column.table_name AND c.column_name = new_name)
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = rename_column.table_name AND c.column_name = old_name) THEN
    RETURN;
  END IF;
  EXECUTE format('ALTER TABLE public.%I RENAME COLUMN %I TO %I', table_name, old_name, new_name);
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION pg_temp.rename_constraint(table_name text, old_name text, new_name text) RETURNS void AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = format('public.%I', table_name)::regclass AND conname = new_name)
    AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = format('public.%I', table_name)::regclass AND conname = old_name) THEN
    RETURN;
  END IF;
  EXECUTE format('ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I', table_name, old_name, new_name);
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION pg_temp.rename_index(old_name text, new_name text) RETURNS void AS $$
BEGIN
  IF to_regclass(format('public.%I', new_name)) IS NOT NULL AND to_regclass(format('public.%I', old_name)) IS NULL THEN
    RETURN;
  END IF;
  EXECUTE format('ALTER INDEX public.%I RENAME TO %I', old_name, new_name);
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
-- A JSON object with one key renamed; unchanged when it doesn't have the old key.
CREATE FUNCTION pg_temp.rename_key(value jsonb, old_key text, new_key text) RETURNS jsonb AS $$
  SELECT CASE WHEN value ? old_key THEN (value - old_key) || jsonb_build_object(new_key, value -> old_key) ELSE value END
$$ LANGUAGE sql IMMUTABLE;
--> statement-breakpoint
SELECT pg_temp.rename_table('bots', 'teammates');
--> statement-breakpoint
SELECT pg_temp.rename_table('bot_threads', 'teammate_threads');
--> statement-breakpoint
SELECT pg_temp.rename_table('desktop_takeovers', 'screen_takeovers');
--> statement-breakpoint
SELECT pg_temp.rename_table('accounts', 'account_connections');
--> statement-breakpoint
SELECT pg_temp.rename_column('teammates', 'is_primary', 'is_lead');
--> statement-breakpoint
SELECT pg_temp.rename_column(c.table_name, c.old_name, c.new_name)
FROM (VALUES
  ('account_actions', 'bot_id', 'teammate_id'),
  ('approval_rules', 'bot_id', 'teammate_id'),
  ('approvals', 'bot_id', 'teammate_id'),
  ('chat_members', 'bot_id', 'teammate_id'),
  ('chats', 'bot_id', 'teammate_id'),
  ('connections', 'bot_ids', 'teammate_ids'),
  ('emails', 'bot_id', 'teammate_id'),
  ('instruction_proposals', 'bot_id', 'teammate_id'),
  ('lessons', 'bot_id', 'teammate_id'),
  ('memory_contexts', 'bot_id', 'teammate_id'),
  ('memory_items', 'bot_id', 'teammate_id'),
  ('message_dispatches', 'bot_id', 'teammate_id'),
  ('notifications', 'bot_id', 'teammate_id'),
  ('page_versions', 'bot_id', 'teammate_id'),
  ('pages', 'bot_id', 'teammate_id'),
  ('purchases', 'bot_id', 'teammate_id'),
  ('runs', 'bot_id', 'teammate_id'),
  ('schedules', 'bot_id', 'teammate_id'),
  ('screen_takeovers', 'requested_by_bot_id', 'requested_by_teammate_id'),
  ('skills', 'bot_id', 'teammate_id'),
  ('skills', 'created_by_bot_id', 'created_by_teammate_id'),
  ('swarms', 'bot_id', 'teammate_id'),
  ('tasks', 'created_by_bot_id', 'created_by_teammate_id'),
  ('tasks', 'owner_bot_id', 'owner_teammate_id'),
  ('teammate_threads', 'bot_id', 'teammate_id'),
  ('triggers', 'bot_id', 'teammate_id'),
  ('vault_items', 'bot_ids', 'teammate_ids')
) AS c(table_name, old_name, new_name);
--> statement-breakpoint
SELECT pg_temp.rename_constraint(c.table_name, c.old_name, c.new_name)
FROM (VALUES
  ('account_actions', 'account_actions_account_id_accounts_id_fk', 'account_actions_account_id_account_connections_id_fk'),
  ('account_actions', 'account_actions_bot_id_bots_id_fk', 'account_actions_teammate_id_teammates_id_fk'),
  ('account_connections', 'accounts_pkey', 'account_connections_pkey'),
  ('account_connections', 'accounts_oauth_client_id_oauth_clients_id_fk', 'account_connections_oauth_client_id_oauth_clients_id_fk'),
  ('approval_rules', 'approval_rules_bot_id_bots_id_fk', 'approval_rules_teammate_id_teammates_id_fk'),
  ('approvals', 'approvals_bot_id_bots_id_fk', 'approvals_teammate_id_teammates_id_fk'),
  ('chat_members', 'chat_members_bot_id_bots_id_fk', 'chat_members_teammate_id_teammates_id_fk'),
  ('chat_members', 'chat_members_chat_id_bot_id_pk', 'chat_members_chat_id_teammate_id_pk'),
  ('chats', 'chats_bot_id_bots_id_fk', 'chats_teammate_id_teammates_id_fk'),
  ('connections', 'connections_account_id_accounts_id_fk', 'connections_account_id_account_connections_id_fk'),
  ('emails', 'emails_bot_id_bots_id_fk', 'emails_teammate_id_teammates_id_fk'),
  ('instruction_proposals', 'instruction_proposals_bot_id_bots_id_fk', 'instruction_proposals_teammate_id_teammates_id_fk'),
  ('lessons', 'lessons_bot_id_bots_id_fk', 'lessons_teammate_id_teammates_id_fk'),
  ('memory_contexts', 'memory_contexts_bot_id_bots_id_fk', 'memory_contexts_teammate_id_teammates_id_fk'),
  ('memory_items', 'memory_items_bot_id_bots_id_fk', 'memory_items_teammate_id_teammates_id_fk'),
  ('message_dispatches', 'message_dispatches_bot_id_bots_id_fk', 'message_dispatches_teammate_id_teammates_id_fk'),
  ('message_dispatches', 'message_dispatches_message_id_bot_id_pk', 'message_dispatches_message_id_teammate_id_pk'),
  ('notifications', 'notifications_bot_id_bots_id_fk', 'notifications_teammate_id_teammates_id_fk'),
  ('page_versions', 'page_versions_bot_id_bots_id_fk', 'page_versions_teammate_id_teammates_id_fk'),
  ('pages', 'pages_bot_id_bots_id_fk', 'pages_teammate_id_teammates_id_fk'),
  ('purchases', 'purchases_bot_id_bots_id_fk', 'purchases_teammate_id_teammates_id_fk'),
  ('runs', 'runs_bot_id_bots_id_fk', 'runs_teammate_id_teammates_id_fk'),
  ('schedules', 'schedules_bot_id_bots_id_fk', 'schedules_teammate_id_teammates_id_fk'),
  ('screen_operations', 'screen_operations_screen_id_bots_id_fk', 'screen_operations_screen_id_teammates_id_fk'),
  ('screen_operations', 'screen_operations_takeover_id_desktop_takeovers_id_fk', 'screen_operations_takeover_id_screen_takeovers_id_fk'),
  ('screen_takeovers', 'desktop_takeovers_pkey', 'screen_takeovers_pkey'),
  ('screen_takeovers', 'desktop_takeovers_interrupted_run_id_runs_id_fk', 'screen_takeovers_interrupted_run_id_runs_id_fk'),
  ('screen_takeovers', 'desktop_takeovers_requested_by_bot_id_bots_id_fk', 'screen_takeovers_requested_by_teammate_id_teammates_id_fk'),
  ('screen_takeovers', 'desktop_takeovers_requested_by_run_id_runs_id_fk', 'screen_takeovers_requested_by_run_id_runs_id_fk'),
  ('screen_takeovers', 'desktop_takeovers_screen_id_bots_id_fk', 'screen_takeovers_screen_id_teammates_id_fk'),
  ('skills', 'skills_bot_id_bots_id_fk', 'skills_teammate_id_teammates_id_fk'),
  ('skills', 'skills_created_by_bot_id_bots_id_fk', 'skills_created_by_teammate_id_teammates_id_fk'),
  ('swarms', 'swarms_bot_id_bots_id_fk', 'swarms_teammate_id_teammates_id_fk'),
  ('takeover_deliveries', 'takeover_deliveries_id_desktop_takeovers_id_fk', 'takeover_deliveries_id_screen_takeovers_id_fk'),
  ('tasks', 'tasks_created_by_bot_id_bots_id_fk', 'tasks_created_by_teammate_id_teammates_id_fk'),
  ('tasks', 'tasks_owner_bot_id_bots_id_fk', 'tasks_owner_teammate_id_teammates_id_fk'),
  ('teammate_threads', 'bot_threads_bot_id_bots_id_fk', 'teammate_threads_teammate_id_teammates_id_fk'),
  ('teammate_threads', 'bot_threads_chat_id_bot_id_pk', 'teammate_threads_chat_id_teammate_id_pk'),
  ('teammate_threads', 'bot_threads_chat_id_chats_id_fk', 'teammate_threads_chat_id_chats_id_fk'),
  ('teammates', 'bots_pkey', 'teammates_pkey'),
  ('triggers', 'triggers_bot_id_bots_id_fk', 'triggers_teammate_id_teammates_id_fk')
) AS c(table_name, old_name, new_name);
--> statement-breakpoint
SELECT pg_temp.rename_index(i.old_name, i.new_name)
FROM (VALUES
  ('accounts_identity_unique', 'account_connections_identity_unique'),
  ('bots_slug_unique', 'teammates_slug_unique'),
  ('chats_bot_idx', 'chats_teammate_idx'),
  ('emails_bot_idx', 'emails_teammate_idx'),
  ('instruction_proposals_bot_idx', 'instruction_proposals_teammate_idx'),
  ('lessons_bot_idx', 'lessons_teammate_idx'),
  ('purchases_bot_idx', 'purchases_teammate_idx'),
  ('runs_bot_idx', 'runs_teammate_idx'),
  ('skills_bot_name_unique', 'skills_teammate_name_unique'),
  ('swarms_bot_idx', 'swarms_teammate_idx')
) AS i(old_name, new_name);
--> statement-breakpoint
-- Who made a skill, task, schedule or trigger: "bot" -> "teammate" (`CREATORS`).
UPDATE skills SET created_by = 'teammate' WHERE created_by = 'bot';
--> statement-breakpoint
UPDATE tasks SET created_by = 'teammate' WHERE created_by = 'bot';
--> statement-breakpoint
UPDATE schedules SET created_by = 'teammate' WHERE created_by = 'bot';
--> statement-breakpoint
UPDATE triggers SET created_by = 'teammate' WHERE created_by = 'bot';
--> statement-breakpoint
-- A teammate's `notify_user`: "bot_message" -> "teammate_message".
UPDATE notifications SET kind = 'teammate_message' WHERE kind = 'bot_message';
--> statement-breakpoint
-- Who saved a memory (`MemorySource`): type "bot" -> "teammate", and `botId` -> `teammateId`.
UPDATE memory_items
SET source = pg_temp.rename_key(
  CASE WHEN source ->> 'type' = 'bot' THEN jsonb_set(source, '{type}', '"teammate"') ELSE source END,
  'botId', 'teammateId')
WHERE source ->> 'type' = 'bot' OR source ? 'botId';
--> statement-breakpoint
UPDATE memory_revisions
SET source = pg_temp.rename_key(
  CASE WHEN source ->> 'type' = 'bot' THEN jsonb_set(source, '{type}', '"teammate"') ELSE source END,
  'botId', 'teammateId')
WHERE source ->> 'type' = 'bot' OR source ? 'botId';
--> statement-breakpoint
-- A teammate's memory scope, `bot:<id>` -> `teammate:<id>`: its generation, and the markers that
-- keep forgotten memories from being learned again (`forgotten:<scope>:<fingerprint>`).
INSERT INTO memory_generations (scope, generation)
SELECT 'teammate:' || substr(scope, 5), generation FROM memory_generations WHERE scope LIKE 'bot:%'
ON CONFLICT (scope) DO UPDATE SET generation = greatest(memory_generations.generation, excluded.generation) + 1;
--> statement-breakpoint
DELETE FROM memory_generations WHERE scope LIKE 'bot:%';
--> statement-breakpoint
INSERT INTO memory_imports (key, created_at)
SELECT 'forgotten:teammate:' || substr(key, 15), created_at FROM memory_imports WHERE key LIKE 'forgotten:bot:%'
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
DELETE FROM memory_imports WHERE key LIKE 'forgotten:bot:%';
--> statement-breakpoint
-- A handoff in a run's timeline (`HandoffItem`): `toBotId`, `toBotName` -> `toTeammateId`, `toTeammateName`.
UPDATE run_events
SET payload = jsonb_set(payload, '{item}',
  pg_temp.rename_key(pg_temp.rename_key(payload -> 'item', 'toBotId', 'toTeammateId'), 'toBotName', 'toTeammateName'))
WHERE payload ->> 'type' = 'item' AND payload -> 'item' ->> 'kind' = 'handoff'
  AND (payload -> 'item' ? 'toBotId' OR payload -> 'item' ? 'toBotName');
--> statement-breakpoint
-- An account sign-in in progress (`OAuthPurpose`): `botIds` -> `teammateIds`.
UPDATE oauth_states SET purpose = pg_temp.rename_key(purpose, 'botIds', 'teammateIds') WHERE purpose ? 'botIds';
--> statement-breakpoint
DROP FUNCTION pg_temp.rename_table(text, text);
--> statement-breakpoint
DROP FUNCTION pg_temp.rename_column(text, text, text);
--> statement-breakpoint
DROP FUNCTION pg_temp.rename_constraint(text, text, text);
--> statement-breakpoint
DROP FUNCTION pg_temp.rename_index(text, text);
--> statement-breakpoint
DROP FUNCTION pg_temp.rename_key(jsonb, text, text);
