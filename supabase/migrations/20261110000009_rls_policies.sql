-- 20261110000009_rls_policies.sql
-- Row level security for every public table. Policies use (select auth.uid())
-- so the planner evaluates it once per statement instead of once per row.
-- service_role has BYPASSRLS and therefore needs no policies; anon gets none.

-- ---------------------------------------------------------------------------
-- Reference tables: readable by signed-in users, writable only by service_role.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['nutrients', 'dri_values', 'exercise_activities', 'app_settings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_read', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Foods: global rows (owner_id is null) readable by all signed-in users; users
-- fully manage only their own custom/recipe/ai_estimate rows.
-- ---------------------------------------------------------------------------
alter table public.foods enable row level security;

drop policy if exists foods_read on public.foods;
create policy foods_read on public.foods
  for select to authenticated
  using (owner_id is null or owner_id = (select auth.uid()));

drop policy if exists foods_insert_own on public.foods;
create policy foods_insert_own on public.foods
  for insert to authenticated
  with check (owner_id = (select auth.uid()) and kind in ('custom', 'recipe', 'ai_estimate'));

drop policy if exists foods_update_own on public.foods;
create policy foods_update_own on public.foods
  for update to authenticated
  using (owner_id = (select auth.uid()) and kind in ('custom', 'recipe', 'ai_estimate'))
  with check (owner_id = (select auth.uid()) and kind in ('custom', 'recipe', 'ai_estimate'));

drop policy if exists foods_delete_own on public.foods;
create policy foods_delete_own on public.foods
  for delete to authenticated
  using (owner_id = (select auth.uid()) and kind in ('custom', 'recipe', 'ai_estimate'));

-- Portions follow their food: readable when the food is, writable for own foods.
-- (The sub-selects on foods are themselves subject to foods RLS.)
alter table public.food_portions enable row level security;

drop policy if exists food_portions_read on public.food_portions;
create policy food_portions_read on public.food_portions
  for select to authenticated
  using (exists (select 1 from public.foods f where f.id = food_portions.food_id));

drop policy if exists food_portions_insert_own on public.food_portions;
create policy food_portions_insert_own on public.food_portions
  for insert to authenticated
  with check (exists (
    select 1 from public.foods f
    where f.id = food_portions.food_id and f.owner_id = (select auth.uid())
  ));

drop policy if exists food_portions_update_own on public.food_portions;
create policy food_portions_update_own on public.food_portions
  for update to authenticated
  using (exists (
    select 1 from public.foods f
    where f.id = food_portions.food_id and f.owner_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.foods f
    where f.id = food_portions.food_id and f.owner_id = (select auth.uid())
  ));

drop policy if exists food_portions_delete_own on public.food_portions;
create policy food_portions_delete_own on public.food_portions
  for delete to authenticated
  using (exists (
    select 1 from public.foods f
    where f.id = food_portions.food_id and f.owner_id = (select auth.uid())
  ));

-- ---------------------------------------------------------------------------
-- Plain owner-only tables (select/insert/update/delete restricted to user_id).
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'meal_groups', 'weight_goals', 'macro_targets', 'nutrient_targets',
    'saved_meals', 'food_usage',
    'exercise_entries', 'biometrics', 'daily_energy', 'notes', 'water_entries', 'fasts', 'integrations',
    'coach_threads', 'coach_messages'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner', t);
    execute format(
      'create policy %I on public.%I for all to authenticated '
      'using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))',
      t || '_owner', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Owner-only tables that also reference foods: the referenced food must be
-- visible to the caller (global or own), so UUIDs of other users' private foods
-- cannot be attached.
-- ---------------------------------------------------------------------------
alter table public.diary_entries enable row level security;
drop policy if exists diary_entries_owner on public.diary_entries;
create policy diary_entries_owner on public.diary_entries
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.foods f where f.id = diary_entries.food_id)
  );

alter table public.favorites enable row level security;
drop policy if exists favorites_owner on public.favorites;
create policy favorites_owner on public.favorites
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.foods f where f.id = favorites.food_id)
  );

-- A recipe row must wrap a food row owned by the same user.
alter table public.recipes enable row level security;
drop policy if exists recipes_owner on public.recipes;
create policy recipes_owner on public.recipes
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.foods f
      where f.id = recipes.food_id and f.owner_id = (select auth.uid()) and f.kind = 'recipe'
    )
  );

-- Child tables without user_id: ownership comes from the parent row.
alter table public.recipe_ingredients enable row level security;
drop policy if exists recipe_ingredients_owner on public.recipe_ingredients;
create policy recipe_ingredients_owner on public.recipe_ingredients
  for all to authenticated
  using (exists (
    select 1 from public.recipes r
    where r.food_id = recipe_ingredients.recipe_food_id and r.user_id = (select auth.uid())
  ))
  with check (
    exists (
      select 1 from public.recipes r
      where r.food_id = recipe_ingredients.recipe_food_id and r.user_id = (select auth.uid())
    )
    and exists (select 1 from public.foods f where f.id = recipe_ingredients.ingredient_food_id)
  );

alter table public.saved_meal_items enable row level security;
drop policy if exists saved_meal_items_owner on public.saved_meal_items;
create policy saved_meal_items_owner on public.saved_meal_items
  for all to authenticated
  using (exists (
    select 1 from public.saved_meals m
    where m.id = saved_meal_items.saved_meal_id and m.user_id = (select auth.uid())
  ))
  with check (
    exists (
      select 1 from public.saved_meals m
      where m.id = saved_meal_items.saved_meal_id and m.user_id = (select auth.uid())
    )
    and exists (select 1 from public.foods f where f.id = saved_meal_items.food_id)
  );

-- ---------------------------------------------------------------------------
-- daily_totals: a cache. Select own only; no write policy (and no write grant).
-- The SECURITY DEFINER trigger function writes it as the table owner.
-- ---------------------------------------------------------------------------
alter table public.daily_totals enable row level security;
drop policy if exists daily_totals_read_own on public.daily_totals;
create policy daily_totals_read_own on public.daily_totals
  for select to authenticated
  using (user_id = (select auth.uid()));
