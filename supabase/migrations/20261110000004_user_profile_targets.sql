-- 20261110000004_user_profile_targets.sql
-- Per-user profile, meal groups and targets + the auth.users signup trigger.
-- Every table here is owner-only (see 20261110000009_rls_policies.sql).

create table if not exists public.profiles (
  user_id            uuid primary key references auth.users (id) on delete cascade,
  display_name       text,
  sex                text check (sex in ('male', 'female')),
  birthdate          date,
  height_cm          numeric check (height_cm is null or height_cm > 0),
  unit_system        text not null default 'metric' check (unit_system in ('metric', 'imperial')),
  timezone           text not null default 'UTC',
  activity_level     text check (activity_level in ('sedentary', 'light', 'moderate', 'very')),
  bmr_formula        text not null default 'mifflin'
                       check (bmr_formula in ('mifflin', 'katch_mcardle', 'harris_benedict', 'cunningham', 'manual')),
  bmr_override       numeric check (bmr_override is null or bmr_override > 0),
  tef_enabled        boolean not null default true,
  energy_mode        text not null default 'static'
                       check (energy_mode in ('static', 'device_adjusted', 'device_total')),
  net_carbs          boolean not null default true,
  pregnant           boolean not null default false,
  lactating          boolean not null default false,
  coach_auto_delete  boolean not null default true,
  onboarded          boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create table if not exists public.meal_groups (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null check (char_length(btrim(name)) > 0),
  sort_order  int not null default 0,
  hidden      boolean not null default false,
  -- target for the composite FK from diary_entries (prevents cross-user references)
  constraint meal_groups_id_user_uk unique (id, user_id)
);

create index if not exists meal_groups_user_idx on public.meal_groups (user_id, sort_order);

create table if not exists public.weight_goals (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  start_weight_kg    numeric not null check (start_weight_kg > 0),
  target_weight_kg   numeric not null check (target_weight_kg > 0),
  rate_kg_per_week   numeric not null default 0,  -- negative = loss
  start_date         date not null default current_date,
  active             boolean not null default true
);

create index if not exists weight_goals_user_idx on public.weight_goals (user_id, active, start_date desc);

create table if not exists public.macro_targets (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  mode              text not null default 'ratios' check (mode in ('ratios', 'fixed', 'keto', 'protein_per_kg')),
  protein_pct       numeric check (protein_pct is null or (protein_pct >= 0 and protein_pct <= 100)),
  carbs_pct         numeric check (carbs_pct is null or (carbs_pct >= 0 and carbs_pct <= 100)),
  fat_pct           numeric check (fat_pct is null or (fat_pct >= 0 and fat_pct <= 100)),
  protein_g         numeric check (protein_g is null or protein_g >= 0),
  carbs_g           numeric check (carbs_g is null or carbs_g >= 0),
  fat_g             numeric check (fat_g is null or fat_g >= 0),
  protein_g_per_kg  numeric check (protein_g_per_kg is null or protein_g_per_kg >= 0),
  net_carbs_g       numeric check (net_carbs_g is null or net_carbs_g >= 0),
  weekday           smallint check (weekday is null or (weekday >= 0 and weekday <= 6)),  -- per-day override
  effective_from    date not null default current_date
);

create index if not exists macro_targets_user_idx on public.macro_targets (user_id, effective_from desc);

-- User overrides of DRI defaults.
create table if not exists public.nutrient_targets (
  user_id        uuid not null references auth.users (id) on delete cascade,
  nutrient_code  text not null references public.nutrients (code) on update cascade on delete cascade,
  min_value      numeric,
  max_value      numeric,
  primary key (user_id, nutrient_code),
  constraint nutrient_targets_range check (min_value is null or max_value is null or min_value <= max_value)
);

-- Signup trigger: profile + default meal groups. SECURITY DEFINER because the
-- inserting role (supabase_auth_admin) has no access to our tables.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, display_name)
  values (new.id, nullif(btrim(split_part(coalesce(new.email, ''), '@', 1)), ''))
  on conflict (user_id) do nothing;

  if found then
    insert into public.meal_groups (user_id, name, sort_order)
    select new.id, g.name, (g.ord - 1)::int * 10
    from unnest(array['Breakfast', 'Lunch', 'Dinner', 'Snacks']) with ordinality as g(name, ord);
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill for users that existed before this migration (no-op on a fresh project).
insert into public.profiles (user_id, display_name)
select u.id, nullif(btrim(split_part(coalesce(u.email, ''), '@', 1)), '')
from auth.users u
where not exists (select 1 from public.profiles p where p.user_id = u.id)
on conflict (user_id) do nothing;

insert into public.meal_groups (user_id, name, sort_order)
select p.user_id, g.name, (g.ord - 1)::int * 10
from public.profiles p
cross join unnest(array['Breakfast', 'Lunch', 'Dinner', 'Snacks']) with ordinality as g(name, ord)
where not exists (select 1 from public.meal_groups m where m.user_id = p.user_id);
