-- 20261110000010_grants.sql
-- Explicit privileges. Supabase's default privileges hand every new public
-- object to anon / authenticated / service_role; we tighten that to least
-- privilege here (RLS stays the second line of defence).
--
--   anon           : nothing at all (the app is invite-only; every call is authenticated)
--   authenticated  : reference tables SELECT, user tables CRUD, daily_totals/app_settings SELECT
--   service_role   : everything (importer, edge functions, cron)

-- Future objects created by this role: do not hand them to anon.
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke execute on functions from anon;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;
grant all on all tables in schema public to service_role;

revoke all on all sequences in schema public from anon, authenticated;
grant all on all sequences in schema public to service_role;

-- Read-only for clients
grant select on
  public.nutrients,
  public.dri_values,
  public.exercise_activities,
  public.app_settings,
  public.daily_totals
to authenticated;

-- Foods: RLS restricts writes to the caller's own custom/recipe/ai_estimate rows
grant select, insert, update, delete on public.foods, public.food_portions to authenticated;

-- Owner-only user data
grant select, insert, update, delete on
  public.profiles,
  public.meal_groups,
  public.weight_goals,
  public.macro_targets,
  public.nutrient_targets,
  public.recipes,
  public.recipe_ingredients,
  public.saved_meals,
  public.saved_meal_items,
  public.favorites,
  public.food_usage,
  public.diary_entries,
  public.exercise_entries,
  public.biometrics,
  public.daily_energy,
  public.notes,
  public.water_entries,
  public.fasts,
  public.integrations,
  public.coach_threads,
  public.coach_messages
to authenticated;

-- ---------------------------------------------------------------------------
-- Functions (PUBLIC has EXECUTE by default; Supabase also grants it to anon /
-- authenticated explicitly, hence the named revokes).
-- ---------------------------------------------------------------------------
revoke all on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;

-- Helpers used inside generated columns / policies / triggers run as the caller
revoke all on function public.immutable_unaccent(text) from public, anon, authenticated;
grant execute on function public.immutable_unaccent(text) to authenticated, service_role;
revoke all on function public.food_source_quality(text) from public, anon, authenticated;
grant execute on function public.food_source_quality(text) to authenticated, service_role;

-- Client RPCs
grant execute on function public.search_foods(text, int, text[]) to authenticated, service_role;
grant execute on function public.get_food_by_gtin(text) to authenticated, service_role;
grant execute on function public.supersede_food(uuid) to authenticated, service_role;
grant execute on function public.delete_all_my_coach_data() to authenticated, service_role;

-- Everything else in `public` (SECURITY DEFINER trigger functions,
-- recompute_daily_totals, purge_old_coach_messages, handle_new_user, ...) stays
-- service_role-only.

-- ---------------------------------------------------------------------------
-- `private` schema: internal helpers, never exposed through the Data API (only
-- `public` is in config.toml [api] schemas). search_foods() calls the ranking
-- helper as the signed-in user, so `authenticated` needs USAGE + EXECUTE.
-- ---------------------------------------------------------------------------
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on all functions in schema private to service_role;
grant execute on function private.search_foods_ranked(text, int, text[]) to authenticated;
