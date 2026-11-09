-- 20261110000006_activity_health.sql
-- Exercise, biometrics, device energy, notes, water, fasting, integrations.
-- All owner-only (RLS in 20261110000009).
--
-- Import idempotency: rows coming from a device carry (source, external_id) and
-- are upserted with
--   insert ... on conflict (user_id, source, external_id) where external_id is not null do update ...

create table if not exists public.exercise_entries (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users (id) on delete cascade,
  entry_date             date not null,  -- user's LOCAL date
  activity_code          text references public.exercise_activities (code) on update cascade on delete set null,
  name                   text not null,
  minutes                numeric check (minutes is null or minutes >= 0),
  kcal                   numeric not null check (kcal >= 0),
  source                 text not null default 'manual'
                           check (source in ('manual', 'apple_health', 'health_connect', 'garmin')),
  external_id            text,
  started_at             timestamptz,
  ended_at               timestamptz,
  counts_toward_energy   boolean not null default true
);

create index if not exists exercise_entries_user_date_idx on public.exercise_entries (user_id, entry_date);
create unique index if not exists exercise_entries_external_uidx
  on public.exercise_entries (user_id, source, external_id)
  where external_id is not null;

create table if not exists public.biometrics (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  entry_date   date not null,  -- user's LOCAL date
  type         text not null check (char_length(btrim(type)) > 0),  -- 'weight', 'body_fat', 'heart_rate_resting', ...
  value        numeric not null,
  unit         text,
  source       text not null default 'manual'
                 check (source in ('manual', 'apple_health', 'health_connect', 'garmin')),
  external_id  text,
  recorded_at  timestamptz not null default now(),
  meta         jsonb not null default '{}'::jsonb
);

create index if not exists biometrics_user_type_date_idx on public.biometrics (user_id, type, entry_date);
create unique index if not exists biometrics_external_uidx
  on public.biometrics (user_id, source, external_id)
  where external_id is not null;

-- Device-reported daily energy (used by energy_mode device_adjusted / device_total).
create table if not exists public.daily_energy (
  user_id      uuid not null references auth.users (id) on delete cascade,
  local_date   date not null,
  source       text not null check (source in ('manual', 'apple_health', 'health_connect', 'garmin')),
  active_kcal  numeric check (active_kcal is null or active_kcal >= 0),
  resting_kcal numeric check (resting_kcal is null or resting_kcal >= 0),
  steps        int check (steps is null or steps >= 0),
  updated_at   timestamptz not null default now(),
  primary key (user_id, local_date, source)
);

drop trigger if exists daily_energy_set_updated_at on public.daily_energy;
create trigger daily_energy_set_updated_at
  before update on public.daily_energy
  for each row execute function public.set_updated_at();

create table if not exists public.notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  entry_date  date not null,
  body        text not null,
  created_at  timestamptz not null default now()
);

create index if not exists notes_user_date_idx on public.notes (user_id, entry_date);

create table if not exists public.water_entries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  entry_date  date not null,
  ml          numeric not null check (ml > 0),
  logged_at   timestamptz not null default now()
);

create index if not exists water_entries_user_date_idx on public.water_entries (user_id, entry_date);

create table if not exists public.fasts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  started_at    timestamptz not null,
  ended_at      timestamptz,
  target_hours  numeric check (target_hours is null or target_hours > 0),
  constraint fasts_end_after_start check (ended_at is null or ended_at >= started_at)
);

create index if not exists fasts_user_started_idx on public.fasts (user_id, started_at desc);

-- Device integrations. NEVER store tokens here: secret_ref is only a reference
-- (e.g. a Vault secret name) to a secret held server-side.
create table if not exists public.integrations (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  provider       text not null check (provider in ('apple_health', 'health_connect', 'garmin')),
  enabled        boolean not null default false,
  settings       jsonb not null default '{}'::jsonb,  -- per-data-type import toggles
  backfill_date  date,
  secret_ref     text,
  last_sync_at   timestamptz,
  constraint integrations_user_provider_uk unique (user_id, provider)
);
