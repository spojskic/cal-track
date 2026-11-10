# Architecture

## Repository layout

```
apps/app/            Expo SDK 58 app (Expo Router): one codebase for iOS, Android and web
  src/app/             routes: (app) tabs, (auth), food/, recipe/, settings/, ai/, coach/ ...
  src/data/            React Query hooks, one file per area (diary, foods, targets, recipes, health ...)
  src/ai/              OpenRouter key store and client wiring, AI gate, coach chat state
  src/health/          Apple Health / Health Connect providers, sync logic, background task
  src/components/      UI by area; src/theme/ colours and spacing; src/lib/ Supabase client, auth
packages/core/       pure TypeScript, no I/O: nutrient catalog, energy and macro maths, intake tables, recipes, scoring,
                     nutrition-label vocabulary and the label -> new-food draft conversion
packages/ai/         OpenRouter client, PKCE sign-in, meal/recipe pipelines, the nutrition-label reader, the coach with its
                     topic guard (depends on packages/core for the label vocabulary)
supabase/            migrations, seeds, config, edge functions
tools/importer/      loads USDA FoodData Central and the Canadian Nutrient File into Postgres
tools/db-tests/      tests that run the real migrations in Postgres-in-WASM (PGlite)
tools/ui-smoke/      browser smoke test against a mocked backend
```

Rule of thumb: anything with logic worth testing lives in `packages/core` or `packages/ai` (plain Node tests); the app is
thin glue around them. The app imports their TypeScript source directly; there is no build step for packages.

## Data model in one page

- **foods**: one row per food, `nutrients` is a JSON object of amounts **per 100 g** keyed by code (`ENERGY_KCAL`,
  `PROTEIN_G` ...). A missing key means *unknown*, which is different from 0. Kinds: generic, branded, custom, recipe,
  ai_estimate. Generic foods come from the importer; branded foods are added on demand when scanned or searched online.
- **food_portions**: household portions. `grams` is the mass of `amount` units (as in USDA data: "2 tbsp = 30 g").
- **diary_entries**: only `food_id` + `grams` + date + meal group. No nutrient copy, to stay inside 500 MB.
  **History stays correct because foods are immutable once logged**: a database trigger rejects nutrient changes on a
  logged food, and edits create a new version (`supersede_food`).
- **daily_totals**: a cache maintained by triggers so charts and the coach read one row per day.
- **User tables** (profile, targets, weight goal, biometrics, exercise, water, notes, recipes, coach chats ...): every table has
  row-level security, so a user can only ever see their own rows. The anon key alone can read nothing.
- **Dates**: a diary day is the user's *local* calendar date, so device data is bucketed by local day too.

The reference tables (`nutrients`, `dri_values`, `exercise_activities`) are generated from `packages/core` by
`pnpm seed:generate`, so the app and the database share one nutrient list. Edge functions cannot import workspace packages,
so a generated copy of the mapping lives in `supabase/functions/_shared/nutrient-map.generated.ts`.

## How the numbers are computed

All in `packages/core`, tested with golden values.

1. **Energy target** = BMR + baseline activity (a fraction of BMR, not a multiplier on top of exercise) + weight-goal delta,
   never below a floor. Resolved in one pure function (`resolveTargets`) from profile, weight, goal and overrides.
2. **Expenditure for a day** depends on the *energy mode*:
   - *static*: BMR + baseline + exercise you logged (net MET calories, because BMR already includes resting burn) + TEF.
   - *device-adjusted*: BMR + baseline + (watch active calories above the baseline) + TEF.
   - *device total*: watch active + resting calories + TEF.
   Watch workouts are stored with `counts_toward_energy = false` because they are already inside the watch's daily total;
   they only cancel overlapping manual entries.
3. **Per-entry nutrients** = food per-100 g amounts x grams / 100, then derived values (net carbs, omega-3/6, an energy
   fallback) honouring the food's carb convention. Day totals sum entries; unknown stays unknown.
4. **Nutrient targets** come from intake tables by age, sex and pregnancy/lactation, plus macro-driven targets, plus your overrides.

## Search and the free-tier budget

- Search runs in Postgres: unaccented full-text plus trigram matching, ranked by your history, then source quality, then text
  similarity. A private `SECURITY DEFINER` function does the indexed work and the public function re-checks row-level security
  (otherwise Postgres would scan the whole table on every keystroke).
- Only **generic** foods are bulk-imported. Branded and Open Food Facts products are fetched on demand and cached, which keeps
  the database near 50 MB instead of several GB.
- Meal photos are never stored. A weekly size check warns at 400 MB; a nightly workflow keeps 30 days of encrypted backups
  because the free plan has none.

## Security model

- The app ships only the Supabase URL and the anon key. All protection is row-level security (tested, including cross-user checks).
- Accounts are created by the owner, or by a friend with an invite code the owner generated (the `sign-up` Edge Function creates the account on the server); public sign-up stays off in Supabase.
- The OpenRouter key never leaves the device. Health data goes only to your own rows.
- Edge functions require a signed-in user (except `sign-up`, which is gated by an invite code, and the Garmin callback and webhook), have per-user, per-client and global rate limits, and use the service key only inside Supabase.

## Decisions worth knowing

| Decision | Why |
| --- | --- |
| Expo + React Native Web, one codebase | One team of one; web, iOS and Android from the same screens |
| Supabase Free, no Docker | Zero cost; tests use PGlite instead of a local Supabase |
| `foods.nutrients` as JSON, not a row per nutrient | About 20x smaller; fits the 500 MB limit |
| Entries store grams, not copied nutrients; foods immutable once logged | Small database and stable history |
| AI picks foods and weights, the database supplies nutrients | LLM nutrient numbers are unreliable; matched numbers are auditable |
| Key on the device, calls straight to OpenRouter | No server holds anyone's key |
| Apple Health / Health Connect first, a direct Garmin link second | Health sync needs no Garmin approval and covers other watches; the OAuth link ([Garmin integration](garmin-integration.md)) adds Garmin-only metrics but needs Garmin's approval, so it ships switched off |
| No over-the-air updates | Needs an Expo account; every change is a rebuild for now |

## Known limits

- Intake-table values and the nutrient ID mapping were written from memory and then partly checked against real USDA files; a
  full review against the NIH tables is still open.
- Food names are English (USDA, Canadian data); custom foods can use any language.
- Nothing has been run on real devices yet; see the [first-run checklist](getting-started.md).
