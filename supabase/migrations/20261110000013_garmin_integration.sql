-- 20261110000013_garmin_integration.sql
-- Server side of the "Connect Garmin" integration (Garmin Connect Developer Program, Starter tier:
-- OAuth2 PKCE + PUSH webhooks). Used by the Edge Functions garmin-oauth-start, garmin-oauth-callback,
-- garmin-webhook and garmin-disconnect. The feature ships dormant (EXPO_PUBLIC_GARMIN_ENABLED).
--
-- Design (follows migrations 08-11):
--   * The three tables live in the `private` schema, which the Data API does not expose (config.toml
--     [api] schemas = ["public"]). They hold OAuth tokens and raw push payloads, so they are SERVICE-ROLE
--     ONLY twice over: not in an exposed schema, and RLS is enabled with NO policies and every privilege is
--     revoked from public / anon / authenticated.
--   * Edge Functions reach them only through narrow `public.*` RPCs that are SECURITY DEFINER with a fixed
--     search_path and EXECUTE for service_role ONLY (the same pattern as public.consume_rate_limit()).
--   * The app reads its own connection STATUS through public.garmin_connection_status(): a SECURITY INVOKER
--     wrapper over private.garmin_connection_status() (the pattern of search_foods() / search_foods_ranked()).
--     It returns four columns for auth.uid() and never a token.
--   * Imported health data goes into the EXISTING tables (daily_energy, exercise_entries, biometrics) with
--     source = 'garmin' through public.apply_garmin_health() (SECURITY INVOKER, service_role only).
--
-- Retention: private.garmin_push_events is a raw buffer. Rows older than 14 days (and OAuth states older than
-- an hour) are deleted by public.purge_garmin_data(). It is scheduled in the Supabase-only pg_cron migration
-- and is also called opportunistically by garmin-webhook, so retention does not depend on pg_cron.

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- One Garmin link per Cal Track user. Tokens are stored in clear text: this table is unreachable for clients
-- (see above); encrypt with Supabase Vault later if the threat model requires it.
create table if not exists private.garmin_connections (
  user_id             uuid primary key references auth.users (id) on delete cascade,
  garmin_user_id      text not null unique check (char_length(garmin_user_id) between 1 and 200),
  access_token        text not null check (char_length(access_token) > 0),
  refresh_token       text,
  expires_at          timestamptz,
  refresh_expires_at  timestamptz,
  scopes              text[] not null default '{}',
  connected_at        timestamptz not null default now(),
  last_push_at        timestamptz,
  last_error          text check (last_error is null or char_length(last_error) <= 500),
  updated_at          timestamptz not null default now()
);

comment on table private.garmin_connections is
  'Garmin OAuth link per user (tokens!). Service role only, reached through public.garmin_* RPCs.';

drop trigger if exists garmin_connections_set_updated_at on private.garmin_connections;
create trigger garmin_connections_set_updated_at
  before update on private.garmin_connections
  for each row execute function public.set_updated_at();

-- PKCE state of a connect attempt in flight: created by garmin-oauth-start, consumed (deleted) exactly once by
-- garmin-oauth-callback. Short lived (TTL is applied on consume; old rows are purged).
create table if not exists private.garmin_oauth_states (
  state          text primary key check (char_length(state) between 16 and 200),
  user_id        uuid not null references auth.users (id) on delete cascade,
  code_verifier  text not null check (char_length(code_verifier) between 43 and 128),
  -- Which app surface to send the browser back to; the URL itself comes from function secrets, never from the client.
  return_kind    text not null default 'native' check (return_kind in ('native', 'web')),
  created_at     timestamptz not null default now()
);

create index if not exists garmin_oauth_states_created_idx on private.garmin_oauth_states (created_at);
create index if not exists garmin_oauth_states_user_idx on private.garmin_oauth_states (user_id);

comment on table private.garmin_oauth_states is
  'Single-use PKCE states of in-flight Garmin connect attempts. Service role only.';

-- Raw push buffer: one row per item Garmin pushed (big sample maps are trimmed by the function before storing).
-- RETENTION: 14 days (public.purge_garmin_data()). Lets a failed mapping be replayed and lets the owner inspect
-- the real push format after Garmin approves the app. user_id is stored so account deletion cascades.
create table if not exists private.garmin_push_events (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references auth.users (id) on delete cascade,
  garmin_user_id  text not null,
  kind            text not null check (char_length(kind) between 1 and 64),
  payload         jsonb not null,
  received_at     timestamptz not null default now(),
  processed_at    timestamptz,
  error           text check (error is null or char_length(error) <= 500)
);

create index if not exists garmin_push_events_received_idx on private.garmin_push_events (received_at);
create index if not exists garmin_push_events_user_idx on private.garmin_push_events (user_id, received_at desc);

comment on table private.garmin_push_events is
  'Raw Garmin push items (trimmed). Retention 14 days. Service role only.';

alter table private.garmin_connections  enable row level security;
alter table private.garmin_oauth_states enable row level security;
alter table private.garmin_push_events  enable row level security;

-- No policies on purpose: nobody but the table owner / service role can touch these rows.
revoke all on table private.garmin_connections  from public, anon, authenticated;
revoke all on table private.garmin_oauth_states from public, anon, authenticated;
revoke all on table private.garmin_push_events  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Connection status for the app (tokens are never part of the result)
-- ---------------------------------------------------------------------------

create or replace function private.garmin_connection_status()
returns table (
  connected     boolean,
  connected_at  timestamptz,
  last_push_at  timestamptz,
  last_error    text
)
language sql
stable
security definer
set search_path = ''
as $$
  select (c.user_id is not null) as connected,
         c.connected_at,
         c.last_push_at,
         c.last_error
  from (select 1) as one
  left join private.garmin_connections c on c.user_id = (select auth.uid())
$$;

comment on function private.garmin_connection_status() is
  'Own Garmin connection status (connected, connected_at, last_push_at, last_error). Never returns tokens.';

create or replace function public.garmin_connection_status()
returns table (
  connected     boolean,
  connected_at  timestamptz,
  last_push_at  timestamptz,
  last_error    text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select s.connected, s.connected_at, s.last_push_at, s.last_error
  from private.garmin_connection_status() as s
$$;

comment on function public.garmin_connection_status() is
  'Client RPC: the signed-in user''s Garmin connection status. SECURITY INVOKER wrapper, no token columns.';

revoke all on function private.garmin_connection_status() from public, anon, authenticated;
grant execute on function private.garmin_connection_status() to authenticated, service_role;
revoke all on function public.garmin_connection_status() from public, anon, authenticated;
grant execute on function public.garmin_connection_status() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- OAuth state: create (start) / consume (callback)
-- ---------------------------------------------------------------------------

create or replace function public.garmin_oauth_state_create(
  p_state          text,
  p_user_id        uuid,
  p_code_verifier  text,
  p_return_kind    text default 'native',
  p_ttl_seconds    int  default 600
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null or p_state is null or p_code_verifier is null
     or p_return_kind is null or p_return_kind not in ('native', 'web') then
    raise exception 'invalid garmin oauth state arguments' using errcode = 'invalid_parameter_value';
  end if;

  -- Housekeeping: expired states, and anything beyond the 4 newest open attempts of this user.
  delete from private.garmin_oauth_states s
   where s.created_at < now() - make_interval(secs => greatest(coalesce(p_ttl_seconds, 600), 60));
  delete from private.garmin_oauth_states s
   where s.user_id = p_user_id
     and s.state not in (
       select o.state from private.garmin_oauth_states o
        where o.user_id = p_user_id order by o.created_at desc limit 4
     );

  insert into private.garmin_oauth_states (state, user_id, code_verifier, return_kind)
  values (p_state, p_user_id, p_code_verifier, p_return_kind);
end;
$$;

-- Atomic single use: the row is always deleted, but only returned while it is still fresh.
create or replace function public.garmin_oauth_state_consume(
  p_state        text,
  p_ttl_seconds  int default 600
)
returns table (user_id uuid, code_verifier text, return_kind text)
language sql
volatile
security definer
set search_path = ''
as $$
  with d as (
    delete from private.garmin_oauth_states s
     where s.state = p_state
    returning s.user_id, s.code_verifier, s.return_kind, s.created_at
  )
  select d.user_id, d.code_verifier, d.return_kind
    from d
   where d.created_at > now() - make_interval(secs => greatest(coalesce(p_ttl_seconds, 600), 1))
$$;

-- ---------------------------------------------------------------------------
-- Connection: save / get / touch / delete
-- ---------------------------------------------------------------------------

create or replace function public.garmin_connection_save(
  p_user_id             uuid,
  p_garmin_user_id      text,
  p_access_token        text,
  p_refresh_token       text,
  p_expires_at          timestamptz,
  p_refresh_expires_at  timestamptz,
  p_scopes              text[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null or coalesce(btrim(p_garmin_user_id), '') = '' or coalesce(p_access_token, '') = '' then
    raise exception 'invalid garmin connection arguments' using errcode = 'invalid_parameter_value';
  end if;

  -- A Garmin account can be linked to one Cal Track user only (unique garmin_user_id -> SQLSTATE 23505).
  insert into private.garmin_connections as c
    (user_id, garmin_user_id, access_token, refresh_token, expires_at, refresh_expires_at, scopes)
  values
    (p_user_id, p_garmin_user_id, p_access_token, p_refresh_token, p_expires_at, p_refresh_expires_at,
     coalesce(p_scopes, '{}'))
  on conflict (user_id) do update
    set connected_at       = case when c.garmin_user_id is distinct from excluded.garmin_user_id
                                  then now() else c.connected_at end,
        garmin_user_id     = excluded.garmin_user_id,
        access_token       = excluded.access_token,
        refresh_token      = coalesce(excluded.refresh_token, c.refresh_token),
        expires_at         = excluded.expires_at,
        refresh_expires_at = coalesce(excluded.refresh_expires_at, c.refresh_expires_at),
        scopes             = excluded.scopes,
        last_error         = null;
end;
$$;

-- Looks a connection up by user id, Garmin user id or access token (whichever is given, first match wins).
create or replace function public.garmin_connection_get(
  p_user_id         uuid default null,
  p_garmin_user_id  text default null,
  p_access_token    text default null
)
returns table (
  user_id             uuid,
  garmin_user_id      text,
  access_token        text,
  refresh_token       text,
  expires_at          timestamptz,
  refresh_expires_at  timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.user_id, c.garmin_user_id, c.access_token, c.refresh_token, c.expires_at, c.refresh_expires_at
    from private.garmin_connections c
   where (p_user_id is not null and c.user_id = p_user_id)
      or (p_garmin_user_id is not null and c.garmin_user_id = p_garmin_user_id)
      or (p_access_token is not null and c.access_token = p_access_token)
   limit 1
$$;

-- A push arrived: p_ok = true stamps last_push_at and clears the error, otherwise the error is recorded.
create or replace function public.garmin_connection_touch(
  p_user_id  uuid,
  p_ok       boolean,
  p_error    text default null
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update private.garmin_connections c
     set last_push_at = case when p_ok then now() else c.last_push_at end,
         last_error   = case when p_ok then null else left(coalesce(p_error, 'error'), 500) end
   where c.user_id = p_user_id
$$;

-- Disconnect / deregistration: removes the link, its tokens, pending states and the raw push buffer of the user.
-- With p_delete_data = true the rows imported from Garmin (source = 'garmin') are removed as well.
create or replace function public.garmin_connection_delete(
  p_user_id      uuid,
  p_delete_data  boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection int := 0;
  v_states     int := 0;
  v_events     int := 0;
  v_energy     int := 0;
  v_exercise   int := 0;
  v_bio        int := 0;
begin
  if p_user_id is null then
    raise exception 'user id required' using errcode = 'invalid_parameter_value';
  end if;

  delete from private.garmin_connections where user_id = p_user_id;
  get diagnostics v_connection = row_count;
  delete from private.garmin_oauth_states where user_id = p_user_id;
  get diagnostics v_states = row_count;
  delete from private.garmin_push_events where user_id = p_user_id;
  get diagnostics v_events = row_count;

  if coalesce(p_delete_data, false) then
    delete from public.daily_energy where user_id = p_user_id and source = 'garmin';
    get diagnostics v_energy = row_count;
    delete from public.exercise_entries where user_id = p_user_id and source = 'garmin';
    get diagnostics v_exercise = row_count;
    delete from public.biometrics where user_id = p_user_id and source = 'garmin';
    get diagnostics v_bio = row_count;
  end if;

  return jsonb_build_object(
    'connection', v_connection,
    'oauth_states', v_states,
    'push_events', v_events,
    'daily_energy', v_energy,
    'exercise_entries', v_exercise,
    'biometrics', v_bio
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Raw push buffer
-- ---------------------------------------------------------------------------

-- p_events = [{"kind": "dailies", "payload": {...}}, ...]; returns the new ids in input order.
create or replace function public.garmin_push_events_record(
  p_user_id         uuid,
  p_garmin_user_id  text,
  p_events          jsonb
)
returns bigint[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids bigint[];
begin
  if p_user_id is null or coalesce(p_garmin_user_id, '') = '' or jsonb_typeof(p_events) is distinct from 'array' then
    raise exception 'invalid garmin push event arguments' using errcode = 'invalid_parameter_value';
  end if;

  with ins as (
    insert into private.garmin_push_events (user_id, garmin_user_id, kind, payload)
    select p_user_id, p_garmin_user_id, left(e.value ->> 'kind', 64), coalesce(e.value -> 'payload', '{}'::jsonb)
      from jsonb_array_elements(p_events) with ordinality as e(value, ord)
     where coalesce(e.value ->> 'kind', '') <> ''
     order by e.ord
    returning id
  )
  select array_agg(ins.id order by ins.id) into v_ids from ins;

  return coalesce(v_ids, '{}');
end;
$$;

create or replace function public.garmin_push_events_finish(
  p_ids    bigint[],
  p_error  text default null
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update private.garmin_push_events e
     set processed_at = now(),
         error        = left(p_error, 500)
   where e.id = any (coalesce(p_ids, '{}'))
$$;

-- Retention: expired OAuth states and push events older than 14 days. service_role only.
create or replace function public.purge_garmin_data(p_event_retention_days int default 14)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_states int;
  v_events int;
begin
  delete from private.garmin_oauth_states where created_at < now() - interval '1 hour';
  get diagnostics v_states = row_count;
  delete from private.garmin_push_events
   where received_at < now() - make_interval(days => greatest(coalesce(p_event_retention_days, 14), 1));
  get diagnostics v_events = row_count;
  return jsonb_build_object('oauth_states', v_states, 'push_events', v_events);
end;
$$;

-- ---------------------------------------------------------------------------
-- Import into the existing health tables (source = 'garmin')
-- ---------------------------------------------------------------------------

-- Applies already-mapped rows (see supabase/functions/_shared/garmin-push.ts) for ONE user in one transaction:
--
--   p_energy     [{local_date, active_kcal, resting_kcal, steps}]
--       Garmin daily summaries are CUMULATIVE for the day and pushed many times (and possibly out of order). The
--       counters of a calendar day never decrease, so GREATEST() keeps the latest value without ever adding pushes
--       together; a NULL (not reported in that push) never erases a stored value. Conflict key = the primary key
--       (user_id, local_date, source), exactly like the Apple Health / Health Connect sync (source 'garmin').
--   p_exercises  [{entry_date, name, minutes, kcal, external_id, started_at, ended_at}]
--       Upsert on the partial unique index (user_id, source, external_id). counts_toward_energy is always false:
--       a device workout is already inside the daily active energy (same rule as the existing sync).
--   p_biometrics [{entry_date, type, value, unit, external_id, recorded_at, meta}]
--       Upsert on the partial unique index (user_id, source, external_id). A row only replaces a stored one when its
--       recorded_at is not older (out-of-order pushes cannot roll a daily value back).
--
-- SECURITY INVOKER: runs with the caller's privileges, i.e. service_role only (EXECUTE is revoked from everyone else).
create or replace function public.apply_garmin_health(
  p_user_id     uuid,
  p_energy      jsonb default '[]'::jsonb,
  p_exercises   jsonb default '[]'::jsonb,
  p_biometrics  jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_energy    int := 0;
  v_exercises int := 0;
  v_bio       int := 0;
begin
  if p_user_id is null then
    raise exception 'user id required' using errcode = 'invalid_parameter_value';
  end if;

  -- Several items of the same day in one call are folded with max() first (same "counters never decrease"
  -- rule), because ON CONFLICT cannot touch one row twice in a statement.
  insert into public.daily_energy as d (user_id, local_date, source, active_kcal, resting_kcal, steps)
  select p_user_id, f.local_date, 'garmin',
         case when f.active_kcal  >= 0 then round(f.active_kcal)  end,
         case when f.resting_kcal >= 0 then round(f.resting_kcal) end,
         case when f.steps        >= 0 then round(f.steps)::int   end
    from (
      select e.local_date,
             max(e.active_kcal)  as active_kcal,
             max(e.resting_kcal) as resting_kcal,
             max(e.steps)        as steps
        from jsonb_to_recordset(coalesce(p_energy, '[]'::jsonb))
             as e(local_date date, active_kcal numeric, resting_kcal numeric, steps numeric)
       where e.local_date is not null
       group by e.local_date
    ) as f
   where f.active_kcal is not null or f.resting_kcal is not null or f.steps is not null
  on conflict (user_id, local_date, source) do update
    set active_kcal  = greatest(d.active_kcal,  excluded.active_kcal),
        resting_kcal = greatest(d.resting_kcal, excluded.resting_kcal),
        steps        = greatest(d.steps,        excluded.steps);
  get diagnostics v_energy = row_count;

  insert into public.exercise_entries as x
    (user_id, entry_date, activity_code, name, minutes, kcal, source, external_id, started_at, ended_at,
     counts_toward_energy)
  select distinct on (e.external_id)
         p_user_id, e.entry_date, null, btrim(e.name), e.minutes, greatest(coalesce(e.kcal, 0), 0), 'garmin',
         e.external_id, e.started_at, e.ended_at, false
    from jsonb_to_recordset(coalesce(p_exercises, '[]'::jsonb))
         as e(entry_date date, name text, minutes numeric, kcal numeric, external_id text,
              started_at timestamptz, ended_at timestamptz)
   where e.entry_date is not null and coalesce(e.external_id, '') <> '' and coalesce(btrim(e.name), '') <> ''
   order by e.external_id, e.started_at desc nulls last
  on conflict (user_id, source, external_id) where external_id is not null do update
    set entry_date           = excluded.entry_date,
        name                 = excluded.name,
        minutes              = excluded.minutes,
        kcal                 = excluded.kcal,
        started_at           = excluded.started_at,
        ended_at             = excluded.ended_at,
        counts_toward_energy = false;
  get diagnostics v_exercises = row_count;

  insert into public.biometrics as b
    (user_id, entry_date, type, value, unit, source, external_id, recorded_at, meta)
  select distinct on (e.external_id)
         p_user_id, e.entry_date, e.type, e.value, e.unit, 'garmin', e.external_id,
         coalesce(e.recorded_at, now()), coalesce(e.meta, '{}'::jsonb)
    from jsonb_to_recordset(coalesce(p_biometrics, '[]'::jsonb))
         as e(entry_date date, type text, value numeric, unit text, external_id text,
              recorded_at timestamptz, meta jsonb)
   where e.entry_date is not null and coalesce(btrim(e.type), '') <> '' and coalesce(e.external_id, '') <> ''
     and e.value is not null and e.value > 0
   order by e.external_id, e.recorded_at desc nulls last
  on conflict (user_id, source, external_id) where external_id is not null do update
    set entry_date  = excluded.entry_date,
        type        = excluded.type,
        value       = excluded.value,
        unit        = excluded.unit,
        recorded_at = excluded.recorded_at,
        meta        = excluded.meta
    where excluded.recorded_at >= b.recorded_at;
  get diagnostics v_bio = row_count;

  return jsonb_build_object('energy', v_energy, 'exercises', v_exercises, 'biometrics', v_bio);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: every function below is for the Edge Functions (service_role) only.
-- ---------------------------------------------------------------------------

revoke all on function public.garmin_oauth_state_create(text, uuid, text, text, int) from public, anon, authenticated;
revoke all on function public.garmin_oauth_state_consume(text, int) from public, anon, authenticated;
revoke all on function public.garmin_connection_save(uuid, text, text, text, timestamptz, timestamptz, text[]) from public, anon, authenticated;
revoke all on function public.garmin_connection_get(uuid, text, text) from public, anon, authenticated;
revoke all on function public.garmin_connection_touch(uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.garmin_connection_delete(uuid, boolean) from public, anon, authenticated;
revoke all on function public.garmin_push_events_record(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.garmin_push_events_finish(bigint[], text) from public, anon, authenticated;
revoke all on function public.purge_garmin_data(int) from public, anon, authenticated;
revoke all on function public.apply_garmin_health(uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;

grant execute on function public.garmin_oauth_state_create(text, uuid, text, text, int) to service_role;
grant execute on function public.garmin_oauth_state_consume(text, int) to service_role;
grant execute on function public.garmin_connection_save(uuid, text, text, text, timestamptz, timestamptz, text[]) to service_role;
grant execute on function public.garmin_connection_get(uuid, text, text) to service_role;
grant execute on function public.garmin_connection_touch(uuid, boolean, text) to service_role;
grant execute on function public.garmin_connection_delete(uuid, boolean) to service_role;
grant execute on function public.garmin_push_events_record(uuid, text, jsonb) to service_role;
grant execute on function public.garmin_push_events_finish(bigint[], text) to service_role;
grant execute on function public.purge_garmin_data(int) to service_role;
grant execute on function public.apply_garmin_health(uuid, jsonb, jsonb, jsonb) to service_role;
