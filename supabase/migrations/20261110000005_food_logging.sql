-- 20261110000005_food_logging.sql
-- Recipes, saved meals, favourites, usage stats, the diary and the daily_totals cache.
--
-- Entries store (food_id, grams) only - no nutrient copy. History stays stable
-- because foods.nutrients / carb_basis / density_g_per_ml are IMMUTABLE once a
-- food is referenced (trigger below); apps create a new version row instead
-- (see public.supersede_food()).
--
-- FKs from user tables to foods are DEFERRABLE INITIALLY DEFERRED so that deleting
-- an auth user (which cascades to both their diary and their custom foods in the
-- same statement) succeeds regardless of cascade order, while deleting a single
-- logged food is still rejected at commit.

create table if not exists public.recipes (
  food_id         uuid primary key references public.foods (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  servings        numeric not null default 1 check (servings > 0),
  final_weight_g  numeric check (final_weight_g is null or final_weight_g > 0),
  notes           text
);

create index if not exists recipes_user_idx on public.recipes (user_id);

create table if not exists public.recipe_ingredients (
  id                  uuid primary key default gen_random_uuid(),
  recipe_food_id      uuid not null references public.recipes (food_id) on delete cascade,
  ingredient_food_id  uuid not null references public.foods (id) deferrable initially deferred,
  grams               numeric not null check (grams > 0),
  sort_order          int not null default 0,
  constraint recipe_ingredients_not_self check (recipe_food_id <> ingredient_food_id)
);

create index if not exists recipe_ingredients_recipe_idx on public.recipe_ingredients (recipe_food_id, sort_order);
create index if not exists recipe_ingredients_ingredient_idx on public.recipe_ingredients (ingredient_food_id);

create table if not exists public.saved_meals (
  id       uuid primary key default gen_random_uuid(),
  user_id  uuid not null references auth.users (id) on delete cascade,
  name     text not null check (char_length(btrim(name)) > 0)
);

create index if not exists saved_meals_user_idx on public.saved_meals (user_id);

create table if not exists public.saved_meal_items (
  id             uuid primary key default gen_random_uuid(),
  saved_meal_id  uuid not null references public.saved_meals (id) on delete cascade,
  food_id        uuid not null references public.foods (id) deferrable initially deferred,
  grams          numeric not null check (grams > 0),
  sort_order     int not null default 0
);

create index if not exists saved_meal_items_meal_idx on public.saved_meal_items (saved_meal_id, sort_order);
create index if not exists saved_meal_items_food_idx on public.saved_meal_items (food_id);

create table if not exists public.favorites (
  user_id     uuid not null references auth.users (id) on delete cascade,
  food_id     uuid not null references public.foods (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, food_id)
);

create index if not exists favorites_food_idx on public.favorites (food_id);

create table if not exists public.food_usage (
  user_id       uuid not null references auth.users (id) on delete cascade,
  food_id       uuid not null references public.foods (id) on delete cascade,
  use_count     int not null default 0,
  last_used_at  timestamptz not null default now(),
  primary key (user_id, food_id)
);

create index if not exists food_usage_recent_idx on public.food_usage (user_id, last_used_at desc);
create index if not exists food_usage_food_idx on public.food_usage (food_id);

create table if not exists public.diary_entries (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  entry_date     date not null,   -- the user's LOCAL calendar date
  meal_group_id  uuid,
  food_id        uuid not null references public.foods (id) deferrable initially deferred,
  grams          numeric not null check (grams > 0),
  amount         numeric,
  portion_label  text,
  source         text not null default 'manual'
                   check (source in ('manual', 'barcode', 'ai_photo', 'ai_text', 'recipe', 'copy', 'quick_add')),
  ai_confidence  real check (ai_confidence is null or (ai_confidence >= 0 and ai_confidence <= 1)),
  note           text,
  logged_at      timestamptz not null default now(),
  -- composite FK: a meal group must belong to the same user; deleting the group
  -- un-assigns the entries instead of deleting them.
  constraint diary_entries_meal_group_fk
    foreign key (meal_group_id, user_id) references public.meal_groups (id, user_id)
    on delete set null (meal_group_id)
);

create index if not exists diary_entries_user_date_idx on public.diary_entries (user_id, entry_date);
create index if not exists diary_entries_food_idx on public.diary_entries (food_id);

-- Cache of per-day sums. Clients may read it, never write it (no write grants /
-- policies). Maintained by trigger from diary_entries.
create table if not exists public.daily_totals (
  user_id      uuid not null references auth.users (id) on delete cascade,
  entry_date   date not null,
  kcal         numeric not null default 0,
  protein_g    numeric not null default 0,
  carbs_g      numeric not null default 0,
  fat_g        numeric not null default 0,
  fiber_g      numeric not null default 0,
  entry_count  int not null default 0,
  nutrients    jsonb not null default '{}'::jsonb,  -- {CODE: sum over entries of per_100g * grams / 100}
  updated_at   timestamptz not null default now(),
  primary key (user_id, entry_date)
);

-- ---------------------------------------------------------------------------
-- daily_totals maintenance
-- ---------------------------------------------------------------------------

-- Recompute one (user, date). SECURITY DEFINER because it writes the read-only
-- cache and must see all of the user's entries; not callable by clients.
create or replace function public.recompute_daily_totals(p_user_id uuid, p_entry_date date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count      integer;
  v_nutrients  jsonb;
begin
  select count(*) into v_count
  from public.diary_entries e
  where e.user_id = p_user_id and e.entry_date = p_entry_date;

  if v_count = 0 then
    delete from public.daily_totals t
    where t.user_id = p_user_id and t.entry_date = p_entry_date;
    return;
  end if;

  select coalesce(jsonb_object_agg(s.code, s.total), '{}'::jsonb)
    into v_nutrients
  from (
    select kv.key as code,
           round(sum((kv.value)::numeric * e.grams / 100.0), 4) as total
    from public.diary_entries e
    join public.foods f on f.id = e.food_id
    cross join lateral jsonb_each(f.nutrients) as kv(key, value)
    where e.user_id = p_user_id
      and e.entry_date = p_entry_date
      and jsonb_typeof(kv.value) = 'number'
    group by kv.key
  ) s;

  insert into public.daily_totals as t
    (user_id, entry_date, kcal, protein_g, carbs_g, fat_g, fiber_g, entry_count, nutrients, updated_at)
  values (
    p_user_id,
    p_entry_date,
    coalesce((v_nutrients ->> 'ENERGY_KCAL')::numeric, 0),
    coalesce((v_nutrients ->> 'PROTEIN_G')::numeric, 0),
    coalesce((v_nutrients ->> 'CARBS_G')::numeric, 0),
    coalesce((v_nutrients ->> 'FAT_G')::numeric, 0),
    coalesce((v_nutrients ->> 'FIBER_G')::numeric, 0),
    v_count,
    v_nutrients,
    now()
  )
  on conflict (user_id, entry_date) do update
    set kcal        = excluded.kcal,
        protein_g   = excluded.protein_g,
        carbs_g     = excluded.carbs_g,
        fat_g       = excluded.fat_g,
        fiber_g     = excluded.fiber_g,
        entry_count = excluded.entry_count,
        nutrients   = excluded.nutrients,
        updated_at  = excluded.updated_at;
end;
$$;

create or replace function public.diary_entries_after_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.recompute_daily_totals(new.user_id, new.entry_date);

    insert into public.food_usage as u (user_id, food_id, use_count, last_used_at)
    values (new.user_id, new.food_id, 1, now())
    on conflict (user_id, food_id) do update
      set use_count = u.use_count + 1,
          last_used_at = now();

  elsif tg_op = 'UPDATE' then
    if (old.user_id, old.entry_date, old.food_id, old.grams)
       is distinct from (new.user_id, new.entry_date, new.food_id, new.grams) then
      perform public.recompute_daily_totals(new.user_id, new.entry_date);
      if (old.user_id, old.entry_date) is distinct from (new.user_id, new.entry_date) then
        perform public.recompute_daily_totals(old.user_id, old.entry_date);
      end if;
    end if;

  else -- DELETE
    perform public.recompute_daily_totals(old.user_id, old.entry_date);
  end if;

  return null;
end;
$$;

drop trigger if exists diary_entries_after_write on public.diary_entries;
create trigger diary_entries_after_write
  after insert or update or delete on public.diary_entries
  for each row execute function public.diary_entries_after_write();

-- ---------------------------------------------------------------------------
-- Nutrient history stability
-- ---------------------------------------------------------------------------

-- Reject changes to nutrients / carb_basis / density_g_per_ml of a food that is
-- referenced by any diary entry or used as a recipe ingredient. SECURITY DEFINER
-- so the check sees every user's rows (RLS would hide other users' references
-- from a client UPDATE; global foods are used by everyone).
create or replace function public.foods_protect_referenced()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.diary_entries d where d.food_id = old.id)
     or exists (select 1 from public.recipe_ingredients r where r.ingredient_food_id = old.id) then
    raise exception
      'food % is referenced by diary entries or recipes: nutrients, carb_basis and density_g_per_ml are immutable',
      old.id
      using errcode = 'restrict_violation',
            hint = 'Create a new version with public.supersede_food() (sets supersedes) and update that row instead.';
  end if;
  return new;
end;
$$;

drop trigger if exists foods_protect_referenced on public.foods;
create trigger foods_protect_referenced
  before update of nutrients, carb_basis, density_g_per_ml on public.foods
  for each row
  when (
    old.nutrients is distinct from new.nutrients
    or old.carb_basis is distinct from new.carb_basis
    or old.density_g_per_ml is distinct from new.density_g_per_ml
  )
  execute function public.foods_protect_referenced();

-- Create the next version of a food: the old row is archived (and, for global
-- foods, its source_id is suffixed '#v<version>' to free the unique
-- (source, source_id) slot), a copy with version+1 / supersedes=old is inserted
-- together with its portions, and the new id is returned. Update the new row's
-- nutrients afterwards (allowed: nothing references it yet).
-- SECURITY INVOKER: RLS decides who may do this (owners for own foods,
-- service_role for global foods).
create or replace function public.supersede_food(p_food_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_old     public.foods;
  v_new_id  uuid;
begin
  select * into v_old from public.foods where id = p_food_id;
  if not found then
    raise exception 'food % not found or not accessible', p_food_id using errcode = 'no_data_found';
  end if;

  update public.foods f
     set archived = true,
         source_id = case
           when f.owner_id is null and f.source_id is not null then f.source_id || '#v' || f.version
           else f.source_id
         end
   where f.id = p_food_id;
  if not found then
    raise exception 'food % may not be modified by the current role', p_food_id using errcode = 'insufficient_privilege';
  end if;

  insert into public.foods
    (source, source_id, kind, owner_id, name, brand, gtin14, category, nutrients, completeness,
     carb_basis, density_g_per_ml, popularity, version, supersedes)
  values
    (v_old.source, v_old.source_id, v_old.kind, v_old.owner_id, v_old.name, v_old.brand, v_old.gtin14,
     v_old.category, v_old.nutrients, v_old.completeness, v_old.carb_basis, v_old.density_g_per_ml,
     v_old.popularity, v_old.version + 1, v_old.id)
  returning id into v_new_id;

  insert into public.food_portions (food_id, label, amount, unit, grams, sort_order)
  select v_new_id, p.label, p.amount, p.unit, p.grams, p.sort_order
  from public.food_portions p
  where p.food_id = p_food_id;

  return v_new_id;
end;
$$;
