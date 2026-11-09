-- 20261110000001_extensions_helpers.sql
-- Extensions and tiny shared helper functions.
--
-- Supabase convention: extensions live in the `extensions` schema (already
-- present on hosted projects; the CREATE SCHEMA is a no-op there and creates
-- it for the PGlite test harness).

create schema if not exists extensions;

create extension if not exists unaccent with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- unaccent() is STABLE (its dictionary can change), so it cannot be used in an
-- index or generated column. The standard workaround is an IMMUTABLE wrapper
-- that pins the dictionary. Everything is schema-qualified, so the function is
-- safe with an empty search_path.
create or replace function public.immutable_unaccent(input text)
returns text
language sql
immutable
parallel safe
strict
set search_path = ''
as $$
  select extensions.unaccent('extensions.unaccent'::pg_catalog.regdictionary, input)
$$;

comment on function public.immutable_unaccent(text) is
  'IMMUTABLE wrapper around extensions.unaccent(); used by foods.search / foods.search_text and search_foods().';

-- Generic updated_at maintainer.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Source quality used for ranking and tie-breaking (1.0 = best).
--   fdc_foundation > fdc_sr_legacy > cnf > cofid > fdc_fndds > fdc_branded > off > ai_estimate
-- 'custom' / 'recipe' rows are always user-owned and get their boost from the
-- "own food" tier instead, so they sit in the middle here.
create or replace function public.food_source_quality(src text)
returns numeric
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case src
    when 'fdc_foundation' then 1.00
    when 'fdc_sr_legacy'  then 0.85
    when 'cnf'            then 0.70
    when 'cofid'          then 0.55
    when 'fdc_fndds'      then 0.40
    when 'fdc_branded'    then 0.25
    when 'off'            then 0.10
    when 'ai_estimate'    then 0.00
    else 0.50
  end::numeric
$$;
