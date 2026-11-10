-- 20261110000101_drop_garmin_push.sql
-- Removes the Garmin PUSH design (Garmin Developer Program: OAuth2 + webhooks into Edge Functions) that
-- 20261110000013_garmin_integration.sql created. That design needed Garmin's approval and was abandoned.
--
-- The replacement needs NO server side at all: the phone signs in on Garmin's own page, keeps the token in its own secure
-- storage, reads Garmin's data itself and saves it through the normal owner-only tables with source = 'garmin'
-- (daily_energy, exercise_entries, biometrics) plus one `integrations` row with provider = 'garmin'. All four tables already
-- accept 'garmin' (check constraints of 20261110000006), so there is NO schema change here, only removals.
--
-- 20261110000013 and the Garmin block of 20261110000090 are already applied on the real project and are NOT edited; this
-- file sorts after 20261110000100_invite_codes.sql so `supabase db push` applies it without --include-all.
--
-- Idempotent: every statement is IF EXISTS, so applying it twice (or on a database where 13 never ran) is a no-op.
-- Data that the push design imported (rows with source = 'garmin' in the three health tables) is left alone; it is the
-- user's own data and the new pull sync writes to the same tables.

-- ---------------------------------------------------------------------------
-- pg_cron: unschedule the daily purge of the push buffer (scheduled by 20261110000090_pg_cron_supabase_only.sql)
-- ---------------------------------------------------------------------------
-- Guarded like migration 90: a database without pg_cron (local Postgres, the PGlite test harness) has no `cron` schema, and
-- cron.unschedule() raises for a job that does not exist, so both are checked. The statements that mention `cron.*` are only
-- planned when that branch is reached.

do $$
begin
  if to_regclass('cron.job') is not null then
    if exists (select 1 from cron.job where jobname = 'purge-garmin-data') then
      perform cron.unschedule('purge-garmin-data');
    end if;
  else
    raise notice 'pg_cron is not available: no Garmin purge job to unschedule';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Functions (names and signatures exactly as in 20261110000013)
-- ---------------------------------------------------------------------------

drop function if exists public.garmin_connection_status();
drop function if exists private.garmin_connection_status();
drop function if exists public.apply_garmin_health(uuid, jsonb, jsonb, jsonb);
drop function if exists public.purge_garmin_data(int);
drop function if exists public.garmin_oauth_state_create(text, uuid, text, text, int);
drop function if exists public.garmin_oauth_state_consume(text, int);
drop function if exists public.garmin_connection_save(uuid, text, text, text, timestamptz, timestamptz, text[]);
drop function if exists public.garmin_connection_get(uuid, text, text);
drop function if exists public.garmin_connection_touch(uuid, boolean, text);
drop function if exists public.garmin_connection_delete(uuid, boolean);
drop function if exists public.garmin_push_events_record(uuid, text, jsonb);
drop function if exists public.garmin_push_events_finish(bigint[], text);

-- ---------------------------------------------------------------------------
-- Tables (schema `private`; they held OAuth tokens and raw push payloads, which no longer exist anywhere)
-- ---------------------------------------------------------------------------

drop table if exists private.garmin_push_events;
drop table if exists private.garmin_oauth_states;
drop table if exists private.garmin_connections;
