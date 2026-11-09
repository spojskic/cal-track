-- 20261110000090_pg_cron_supabase_only.sql
--
-- SUPABASE-ONLY MIGRATION. The `_supabase_only` suffix is a convention: the
-- PGlite test harness (tools/db-tests) SKIPS every migration whose name contains
-- "supabase_only", because PGlite has neither pg_cron nor Supabase's managed
-- extensions. Everything that cannot run in plain Postgres belongs here (cron
-- schedules, Vault, realtime publication changes, ...).
--
-- Schedules the coach retention purge daily at 03:00 UTC. Guarded so that it is
-- a harmless no-op on a database where pg_cron is not available. Re-running
-- replaces the job of the same name (cron.schedule upserts by job name).

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    -- Supabase installs pg_cron into pg_catalog / creates the `cron` schema itself.
    create extension if not exists pg_cron;

    perform cron.schedule(
      'purge-old-coach-messages',
      '0 3 * * *',
      $job$select public.purge_old_coach_messages()$job$
    );
  else
    raise notice 'pg_cron is not available: coach message purge is NOT scheduled';
  end if;
end $$;
