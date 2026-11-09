-- 20261110000003_foods.sql
-- Food catalogue. Lean by design (Supabase free tier, 500 MB): one row per food,
-- nutrients stored as jsonb per 100 g, keyed by nutrients.code. A missing key
-- means "unknown", never zero.

create table if not exists public.foods (
  id                uuid primary key default gen_random_uuid(),
  source            text not null check (source in (
                      'fdc_foundation', 'fdc_sr_legacy', 'fdc_fndds', 'fdc_branded',
                      'cnf', 'cofid', 'off', 'custom', 'recipe', 'ai_estimate')),
  source_id         text,
  kind              text not null check (kind in ('generic', 'branded', 'custom', 'recipe', 'ai_estimate')),
  owner_id          uuid references auth.users (id) on delete cascade,  -- NULL = global
  name              text not null check (char_length(btrim(name)) > 0),
  brand             text,
  gtin14            text,
  category          text,
  nutrients         jsonb not null default '{}'::jsonb,
  completeness      real check (completeness is null or (completeness >= 0 and completeness <= 1)),
  carb_basis        text not null default 'includes_fiber' check (carb_basis in ('includes_fiber', 'excludes_fiber')),
  density_g_per_ml  real check (density_g_per_ml is null or density_g_per_ml > 0),
  popularity        int not null default 0,
  version           int not null default 1,
  supersedes        uuid references public.foods (id) on delete set null,
  archived          boolean not null default false,
  -- Search columns are generated so they can never drift from name/brand.
  search_text       text generated always as (
                      lower(public.immutable_unaccent(name || ' ' || coalesce(brand, '')))
                    ) stored,
  search            tsvector generated always as (
                      to_tsvector('simple'::regconfig, lower(public.immutable_unaccent(name || ' ' || coalesce(brand, ''))))
                    ) stored,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint foods_nutrients_numeric_object check (
    jsonb_typeof(nutrients) = 'object'
    and not jsonb_path_exists(nutrients, '$.* ? (@.type() != "number")')
  ),
  constraint foods_gtin14_format check (gtin14 is null or gtin14 ~ '^[0-9]{14}$')
);

comment on table public.foods is
  'Food catalogue. owner_id NULL = global (written only by service_role). nutrients = {CODE: amount per 100 g}.';
comment on column public.foods.nutrients is
  'jsonb {"ENERGY_KCAL": 52, ...} per 100 g. Missing key = unknown (not zero). Immutable once the food is logged/used in a recipe.';
comment on column public.foods.gtin14 is
  'GTIN normalised to 14 digits (left-padded with zeros by trigger). NOT unique: several sources can share a GTIN; get_food_by_gtin() picks the best row.';

-- One row per (source, source_id) among GLOBAL foods; the importer upserts on it:
--   on conflict (source, source_id) where source_id is not null and owner_id is null
create unique index if not exists foods_global_source_uidx
  on public.foods (source, source_id)
  where source_id is not null and owner_id is null;

-- Full-text (prefix-friendly) + trigram (typo-tolerant) search.
-- fastupdate = off: the catalogue is read-mostly (one bulk import, then a trickle
-- of user foods). With the default pending list every search has to read the
-- whole unflushed list after a bulk load (hundreds of pages) until vacuum runs;
-- writing straight into the index keeps search latency predictable.
create index if not exists foods_search_gin_idx
  on public.foods using gin (search) with (fastupdate = off);
create index if not exists foods_search_text_trgm_idx
  on public.foods using gin (search_text extensions.gin_trgm_ops) with (fastupdate = off);

-- GTIN: deliberately NOT unique (two global sources can carry the same barcode).
create index if not exists foods_gtin14_idx
  on public.foods (gtin14) where gtin14 is not null;
create index if not exists foods_owner_idx
  on public.foods (owner_id) where owner_id is not null;
create index if not exists foods_supersedes_idx
  on public.foods (supersedes) where supersedes is not null;

-- Normalise GTIN to 14 digits and maintain updated_at.
create or replace function public.foods_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_digits text;
begin
  if new.gtin14 is not null then
    v_digits := regexp_replace(new.gtin14, '\D', '', 'g');
    if v_digits = '' or v_digits ~ '^0+$' or char_length(v_digits) > 14 then
      new.gtin14 := null;
    else
      new.gtin14 := lpad(v_digits, 14, '0');
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists foods_before_write on public.foods;
create trigger foods_before_write
  before insert or update on public.foods
  for each row execute function public.foods_before_write();

create table if not exists public.food_portions (
  id          uuid primary key default gen_random_uuid(),
  food_id     uuid not null references public.foods (id) on delete cascade,
  label       text not null,                    -- "1 cup, chopped"
  amount      numeric check (amount is null or amount > 0),  -- 1
  unit        text,                             -- "cup"
  grams       numeric not null check (grams > 0),
  sort_order  int not null default 0
);

create index if not exists food_portions_food_idx
  on public.food_portions (food_id, sort_order);
