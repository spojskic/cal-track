-- 20261110000008_search_functions.sql
-- Client-facing search RPCs.
--
-- search_foods() is SECURITY INVOKER (RLS applies), but it is split in two:
--
--   private.search_foods_ranked()  SECURITY DEFINER, in the non-exposed `private`
--       schema. Does the index-driven matching and ranking. It exists because
--       with RLS enabled Postgres refuses to use an index for a qual whose
--       operator is not "leakproof", and `tsvector @@ tsquery` and pg_trgm's
--       `<%` are not: an invoker query would degrade to a full sequential scan
--       of `foods` on every keystroke. The function applies the same visibility
--       rule explicitly (global rows + auth.uid()'s own rows).
--
--   public.search_foods()          SECURITY INVOKER wrapper. Re-checks every
--       returned row against `foods` UNDER RLS, so RLS remains the final gate
--       even if the helper were ever wrong, and it is the only entry point
--       exposed through the API.

create schema if not exists private;
comment on schema private is 'Internal functions. NOT exposed through the Data API (config.toml [api] schemas = ["public"]).';

-- search_foods_ranked(q, max_results, kinds)
--
-- Matching (accent- and case-insensitive; 'cevapi' finds 'Ćevapi'):
--   * full-text: every query word is a PREFIX match on foods.search (GIN)
--   * trigram fallback for typos: q <% foods.search_text (GIN, word similarity,
--     only for queries of >= 3 characters). Fuzzy-only hits can never outrank
--     comparable prefix hits because they miss the +0.30 full-text bonus.
--
-- Ranking (higher = better; `rank` is that score). The priority list is
-- implemented as additive weights so tiers dominate in this order but a vastly
-- better text match can still win:
--   1. personal  : own custom foods (+0.60), previously logged foods
--                  (+0.35 .. +0.70 by frequency and recency), favourites (+0.25)
--   2. source    : 0.20 * food_source_quality()  (foundation > sr_legacy > cnf >
--                  cofid > fndds > branded > off > ai_estimate; max spread 0.20)
--   3. text      : 0.30 fts hit + 0.40 word_similarity + 0.20 similarity
--                  + 0.10 name-starts-with-query   (0 .. 1.0)
--   4. quality   : 0.05 * completeness + up to 0.03 * popularity
-- Archived foods are hidden. Returns a small summary payload only.
create or replace function private.search_foods_ranked(
  q            text,
  max_results  int default 25,
  kinds        text[] default null
)
returns table (
  id             uuid,
  name           text,
  brand          text,
  kind           text,
  source         text,
  kcal_100g      numeric,
  protein_100g   numeric,
  carbs_100g     numeric,
  fat_100g       numeric,
  completeness   real,
  rank           real
)
language plpgsql
stable
rows 25   -- planner hint: without it (default 1000) the wrapper's RLS re-check becomes a seq scan + hash semi join
security definer
set search_path = ''
set pg_trgm.word_similarity_threshold = '0.45'
as $$
#variable_conflict use_column
declare
  v_uid      uuid := (select auth.uid());
  v_qn       text;
  v_tsq      tsquery;
  v_fuzzy_q  text;
  v_limit    int := least(greatest(coalesce(max_results, 25), 1), 100);
  v_kinds    text[] := case when coalesce(cardinality(kinds), 0) = 0 then null else kinds end;
begin
  -- normalise: unaccent + lower + collapse whitespace, cap length
  v_qn := btrim(regexp_replace(lower(public.immutable_unaccent(left(coalesce(q, ''), 100))), '\s+', ' ', 'g'));
  if v_qn = '' then
    return;
  end if;

  -- AND of prefix terms, built from parser-produced lexemes (injection-safe)
  select to_tsquery('simple'::regconfig,
                    string_agg('''' || replace(t.lexeme, '''', '''''') || ''':*', ' & '))
    into v_tsq
  from unnest(to_tsvector('simple'::regconfig, v_qn)) as t;

  if v_tsq is null then   -- punctuation only
    return;
  end if;

  -- NULL disables the (noisy for 1-2 chars) trigram branch; `NULL <% x` matches nothing
  v_fuzzy_q := case when char_length(v_qn) >= 3 then v_qn else null end;

  return query
  select s.id, s.name, s.brand, s.kind, s.source,
         s.kcal_100g, s.protein_100g, s.carbs_100g, s.fat_100g,
         s.completeness, s.score::real
  from (
    select
      f.id, f.name, f.brand, f.kind, f.source,
      (f.nutrients ->> 'ENERGY_KCAL')::numeric as kcal_100g,
      (f.nutrients ->> 'PROTEIN_G')::numeric   as protein_100g,
      (f.nutrients ->> 'CARBS_G')::numeric     as carbs_100g,
      (f.nutrients ->> 'FAT_G')::numeric       as fat_100g,
      f.completeness,
      (
        -- 1. personal
        case when f.owner_id is not null then 0.60 else 0 end
        + case when u.food_id is not null then
            0.35
            + least(0.25, 0.06 * ln(1 + u.use_count)::float8)
            + 0.10 / (1 + (extract(epoch from (now() - u.last_used_at)) / 86400.0 / 14.0))::float8
          else 0 end
        + case when fav.food_id is not null then 0.25 else 0 end
        -- 2. source quality
        + 0.20 * public.food_source_quality(f.source)::float8
        -- 3. text relevance
        + case when f.search @@ v_tsq then 0.30 else 0 end
        + 0.40 * extensions.word_similarity(v_qn, f.search_text)::float8
        + 0.20 * extensions.similarity(v_qn, f.search_text)::float8
        + case when starts_with(f.search_text, v_qn) then 0.10 else 0 end
        -- 4. completeness, popularity
        + 0.05 * coalesce(f.completeness, 0)::float8
        + 0.03 * least(1.0, ln(1 + greatest(f.popularity, 0))::float8 / 10.0)
      ) as score
    from public.foods f
    left join public.food_usage u on u.food_id = f.id and u.user_id = v_uid
    left join public.favorites fav on fav.food_id = f.id and fav.user_id = v_uid
    where not f.archived
      and (f.owner_id is null or f.owner_id = v_uid)
      and (v_kinds is null or f.kind = any (v_kinds))
      and (f.search @@ v_tsq or v_fuzzy_q operator(extensions.<%) f.search_text)
  ) s
  order by s.score desc, char_length(s.name), s.name, s.id
  limit v_limit;
end;
$$;

-- Public entry point (SECURITY INVOKER): RLS has the last word on every row.
create or replace function public.search_foods(
  q            text,
  max_results  int default 25,
  kinds        text[] default null
)
returns table (
  id             uuid,
  name           text,
  brand          text,
  kind           text,
  source         text,
  kcal_100g      numeric,
  protein_100g   numeric,
  carbs_100g     numeric,
  fat_100g       numeric,
  completeness   real,
  rank           real
)
language sql
stable
security invoker
set search_path = ''
as $$
  select r.id, r.name, r.brand, r.kind, r.source,
         r.kcal_100g, r.protein_100g, r.carbs_100g, r.fat_100g,
         r.completeness, r.rank
  from private.search_foods_ranked(q, max_results, kinds) r
  where exists (select 1 from public.foods f where f.id = r.id)   -- RLS gate (pk lookup, <= 100 rows)
  order by r.rank desc, char_length(r.name), r.name, r.id
$$;

comment on function public.search_foods(text, int, text[]) is
  'Accent-insensitive prefix + typo-tolerant food search with personalised ranking. Summary columns only. SECURITY INVOKER; ranking runs in private.search_foods_ranked().';

-- get_food_by_gtin(gtin)
--
-- Normalises any GTIN/UPC/EAN (8, 12, 13, 14 digits; separators ignored) to
-- GTIN-14 by left-padding with zeros, and returns the single best matching
-- non-archived food visible to the caller (0 or 1 row; use .maybeSingle()).
-- Best = caller's own food first, then source quality, then completeness.
-- foods.gtin14 is NOT unique: if two global sources share a barcode both rows
-- exist and this function picks the better one.
create or replace function public.get_food_by_gtin(gtin text)
returns setof public.foods
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_digits  text := regexp_replace(coalesce(gtin, ''), '\D', '', 'g');
begin
  if v_digits = '' or v_digits ~ '^0+$' or char_length(v_digits) > 14 then
    return;
  end if;

  return query
  select f.*
  from public.foods f
  where f.gtin14 = lpad(v_digits, 14, '0')
    and not f.archived
    and (f.owner_id is null or f.owner_id = v_uid)
  order by (f.owner_id is not null) desc,
           public.food_source_quality(f.source) desc,
           f.completeness desc nulls last,
           f.created_at,
           f.id
  limit 1;
end;
$$;

comment on function public.get_food_by_gtin(text) is
  'Best visible food for a barcode (any GTIN length, padded to 14). Returns 0 or 1 row.';
