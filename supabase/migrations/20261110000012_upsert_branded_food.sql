-- 20261110000012_upsert_branded_food.sql
-- Server-side upsert of ONE global branded food (+ its portions), called by the
-- `barcode-lookup` Edge Function with the SERVICE ROLE.
--
-- Why an RPC: the unique index on foods is partial
--   (source, source_id) where source_id is not null and owner_id is null
-- and PostgREST's `upsert(onConflict: 'source,source_id')` cannot carry the index
-- predicate, so Postgres would not infer the index. Doing it in a function also
-- makes "upsert food + replace portions" one transaction.
--
-- Semantics (p_food = {source, source_id, name, brand, gtin14, category, nutrients,
-- completeness, carb_basis, density_g_per_ml}; source must be fdc_branded or off):
--   * no row yet                         -> INSERT                        action 'inserted'
--   * row exists, nothing changed        -> no write                      action 'unchanged'
--     (only the portions differ: portions are replaced, action 'updated')
--   * row exists, only metadata changed  -> UPDATE                        action 'updated'
--     (or nutrients changed but nothing references the food)
--   * nutrients / carb_basis / density changed and the food is referenced by diary
--     entries or recipe ingredients -> supersede_food() (archive old row, new version)
--     and update the NEW row                                              action 'superseded'
--   Portions are replaced only when they differ.
-- Returns {action, food, portions}; the foods row is returned without its generated
-- search columns.
--
-- SECURITY INVOKER on purpose: it runs with the caller's privileges, i.e. only
-- service_role can use it (EXECUTE is revoked from everyone else). RLS would block a
-- normal user from writing global rows even if the grant were misconfigured.

create or replace function public.upsert_branded_food(
  p_food      jsonb,
  p_portions  jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_source       text    := p_food ->> 'source';
  v_source_id    text    := p_food ->> 'source_id';
  v_name         text    := p_food ->> 'name';
  v_brand        text    := p_food ->> 'brand';
  v_gtin14       text    := p_food ->> 'gtin14';
  v_category     text    := p_food ->> 'category';
  v_nutrients    jsonb   := coalesce(p_food -> 'nutrients', '{}'::jsonb);
  v_completeness real    := (p_food ->> 'completeness')::real;
  v_carb_basis   text    := coalesce(p_food ->> 'carb_basis', 'includes_fiber');
  v_density      real    := (p_food ->> 'density_g_per_ml')::real;
  v_portions     jsonb   := coalesce(p_portions, '[]'::jsonb);
  v_id           uuid;
  v_target       uuid;
  v_old          public.foods;
  v_action       text;
  v_changed      boolean;
  v_referenced   boolean;
  v_old_portions jsonb;
  v_new_portions jsonb;
begin
  if v_source is null or v_source not in ('fdc_branded', 'off') then
    raise exception 'upsert_branded_food: source must be fdc_branded or off' using errcode = 'invalid_parameter_value';
  end if;
  if v_source_id is null or btrim(v_source_id) = '' then
    raise exception 'upsert_branded_food: source_id is required' using errcode = 'invalid_parameter_value';
  end if;
  if jsonb_typeof(v_portions) <> 'array' then
    raise exception 'upsert_branded_food: p_portions must be a JSON array' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.foods
    (source, source_id, kind, owner_id, name, brand, gtin14, category,
     nutrients, completeness, carb_basis, density_g_per_ml, popularity)
  values
    (v_source, v_source_id, 'branded', null, v_name, v_brand, v_gtin14, v_category,
     v_nutrients, v_completeness, v_carb_basis, v_density, 0)
  on conflict (source, source_id) where source_id is not null and owner_id is null
  do nothing
  returning id into v_id;

  if v_id is not null then
    v_target := v_id;
    v_action := 'inserted';
  else
    select * into v_old
    from public.foods f
    where f.source = v_source and f.source_id = v_source_id and f.owner_id is null
    for update;
    if not found then
      raise exception 'upsert_branded_food: conflicting row vanished' using errcode = 'serialization_failure';
    end if;
    v_target := v_old.id;

    v_changed := (v_old.nutrients, v_old.carb_basis, v_old.density_g_per_ml)
                 is distinct from (v_nutrients, v_carb_basis, v_density);

    if not v_changed
       and (v_old.name, v_old.brand, v_old.gtin14, v_old.category, v_old.completeness)
           is not distinct from (v_name, v_brand,
                                 case when v_gtin14 ~ '^[0-9]{1,14}$' and v_gtin14 !~ '^0+$'
                                      then lpad(v_gtin14, 14, '0') end,
                                 v_category, v_completeness) then
      v_action := 'unchanged';
    else
      v_referenced := false;
      if v_changed then
        v_referenced := exists (select 1 from public.diary_entries d where d.food_id = v_old.id)
                     or exists (select 1 from public.recipe_ingredients r where r.ingredient_food_id = v_old.id);
      end if;

      if v_referenced then
        -- History is immutable: archive the old version and edit the new one.
        v_target := public.supersede_food(v_old.id);
        v_action := 'superseded';
      else
        v_action := 'updated';
      end if;

      update public.foods f
         set name = v_name,
             brand = v_brand,
             gtin14 = v_gtin14,
             category = v_category,
             nutrients = v_nutrients,
             completeness = v_completeness,
             carb_basis = v_carb_basis,
             density_g_per_ml = v_density
       where f.id = v_target;
    end if;
  end if;

  -- Portions: replace when different (labels are display-only; diary rows keep their own copy).
  select coalesce(jsonb_agg(jsonb_build_object(
           'label', p.label, 'amount', p.amount, 'unit', p.unit, 'grams', p.grams, 'sort_order', p.sort_order)
           order by p.sort_order, p.label), '[]'::jsonb)
    into v_old_portions
    from public.food_portions p
   where p.food_id = v_target;

  select coalesce(jsonb_agg(jsonb_build_object(
           'label', x.label, 'amount', x.amount, 'unit', x.unit, 'grams', x.grams,
           'sort_order', coalesce(x.sort_order, 0))
           order by coalesce(x.sort_order, 0), x.label), '[]'::jsonb)
    into v_new_portions
    from jsonb_to_recordset(v_portions)
         as x(label text, amount numeric, unit text, grams numeric, sort_order int);

  if v_old_portions is distinct from v_new_portions then
    delete from public.food_portions where food_id = v_target;
    insert into public.food_portions (food_id, label, amount, unit, grams, sort_order)
    select v_target, x.label, x.amount, x.unit, x.grams, coalesce(x.sort_order, 0)
      from jsonb_to_recordset(v_portions)
           as x(label text, amount numeric, unit text, grams numeric, sort_order int);
    if v_action = 'unchanged' then
      v_action := 'updated';   -- only the portions changed
    end if;
  end if;

  return jsonb_build_object(
    'action', v_action,
    'food', (select to_jsonb(f) - 'search' - 'search_text' from public.foods f where f.id = v_target),
    'portions', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', p.id, 'label', p.label, 'amount', p.amount, 'unit', p.unit,
               'grams', p.grams, 'sort_order', p.sort_order)
               order by p.sort_order, p.label), '[]'::jsonb)
        from public.food_portions p
       where p.food_id = v_target)
  );
end;
$$;

comment on function public.upsert_branded_food(jsonb, jsonb) is
  'Upserts one global branded food (fdc_branded / off) and its portions in one transaction. service_role only. Returns {action, food, portions}.';

revoke all on function public.upsert_branded_food(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.upsert_branded_food(jsonb, jsonb) to service_role;
