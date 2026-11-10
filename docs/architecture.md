# Architecture

## Repository layout

```
apps/app/            Expo SDK 58 app (Expo Router): one codebase for iOS, Android and web
  src/app/             routes: (app) tabs, (auth), food/, recipe/, settings/, ai/, coach/ ...
  src/data/            React Query hooks, one file per area (diary, foods, targets, recipes, health ...)
  src/ai/              OpenRouter key store and client wiring, AI gate, coach chat state
  src/health/          Apple Health / Health Connect providers, sync logic, background task
  src/components/      UI by area; src/theme/ colours, corner radii and spacing; src/lib/ Supabase client, auth
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
2. **Expenditure for a day** ("Burned") is assembled the way Cronometer does it, and depends on the *energy mode*:
   `Burned = BMR + adjusted baseline activity + tracker activity + exercise (+ TEF)`. The baseline activity is a fraction of
   BMR chosen by the activity level; it is the allowance for everything that is not exercise and not measured, so at the
   start of the day `Burned = BMR + baseline` and meals can be planned before the watch recorded anything. It is then used up:
   - *static* and *device-adjusted* (Cronometer's model; `AWAKE_HOURS = 16`):
     `trackerActivity = max(0, deviceActive - deviceWorkoutKcal)` (watch movement outside workouts; 0 in static),
     `exercise = deviceWorkoutKcal + manualExerciseKcal` (manual only in static; net MET calories, because BMR already
     includes resting burn),
     `adjustedBaseline = max(0, baseline - trackerActivity - baseline / 16 * exerciseHours)`.
     Tracker activity replaces the baseline one for one, and every hour of exercise (watch workouts plus manual entries
     with a duration) removes one sixteenth of it, because you were not doing everyday movement then. Once both used it up the
     adjusted baseline is 0 and disappears from the breakdown.
   - *device total*: watch active + resting calories (+ TEF); no baseline.

   Example (Cronometer's): BMR 1394, baseline 279, a 60 minute ride of 500 kcal -> adjusted baseline `279 - 279/16 = 261.5625`,
   `Burned = 1394 + 261.5625 + 500 = 2155.5625`.

   Watch workouts are stored with `counts_toward_energy = false` because they are already inside the watch's daily active
   total; they are not added again, they only split that total into tracker activity and exercise, supply exercise minutes,
   and cancel overlapping manual entries. Only the workouts of the source whose daily total is used are read (a session
   recorded by two apps is not counted twice). Without a daily total from the watch, device-adjusted behaves like static.

   The third circle of the energy summary has two views, switched by tapping its label (stored in
   `profiles.energy_summary_mode`): *Target* shows `(energy target + energy burned above the baseline) - consumed`
   (Remaining or Over), with `above baseline = max(0, adjusted baseline + tracker activity + exercise - baseline)`, e.g.
   `1673 + 482.5625` in the example above; TEF is not added to the budget. *Balance* shows `Burned (incl. TEF) - consumed`
   (Deficit or Surplus) and ignores the weight goal. The macro targets always use the energy target.
3. **Per-entry nutrients** = food per-100 g amounts x grams / 100, then derived values (net carbs, omega-3/6, an energy
   fallback) honouring the food's carb convention. Day totals sum entries; unknown stays unknown.
4. **Nutrient targets** come from intake tables by age, sex and pregnancy/lactation, plus macro-driven targets, plus your overrides.

## Themes

The colours of every screen come from `useTheme()` in `apps/app/src/theme/`, which returns `{ colors, isDark, paletteId, corners, radius, shape }`.

- **Palette data is pure TypeScript** (no React Native import, so the Node tests can load it): `colors.ts` (the `ThemeColors` tokens,
  `withAlpha`, the original Cal Track look), `contrast.ts` (WCAG maths), `define-colors.ts` (derives each `on*` text colour, and the
  scrim, from the palette's own darkest and lightest inks), `palettes-light.ts` / `palettes-dark.ts` (22 palettes, all plain `#RRGGBB`
  because components append a 2-digit alpha to tokens) and `palettes.ts` (the registry, the defaults, the saved-choice rules and
  `resolvePalette`). `tools/ui-smoke/src/theme.test.ts` checks every palette for completeness and for contrast floors.
- **The choice is device-local**: `theme-store.ts` is a small zustand store
  (`{ mode: 'system' | 'light' | 'dark', light, dark, corners: 'rounded' | 'boxy' }`) saved under `cal-track.theme.v1` in AsyncStorage (localStorage on the web), like the AI preferences. An unknown or removed id falls
  back to the default of its side, a missing or unknown `corners` (a choice saved before the Boxy look existed) to `rounded`, so the key
  was not bumped. No profile column and no migration. On the web the stored value is read synchronously when the
  module loads, so the first paint already has the right palette; on native the splash screen waits for the read (1.5 s at most).
- **`useTheme()` resolves** the palette from the store and, for *Match system*, from `useColorScheme()`. `isDark` is the palette's own
  appearance. The `colors` object is the same instance for a given palette, so it is safe in dependency lists.
- **Corners (`shape.ts`, pure)**: two radius scales, `ROUNDED_RADII = { sm: 8, md: 12, lg: 16, pill: 999 }` (exactly the old static
  constant, so the default look is unchanged) and `BOXY_RADII = { sm: 3, md: 4, lg: 6, pill: 4 }`, plus helpers for round things that
  are not on the scale: `shape.circle(size)` (a round button: `size / 2`, in Boxy a rounded square of at most 4), `shape.bar(height)`
  (a progress track: `height / 2`, in Boxy at most 2), `shape.px(n)` (a fixed radius: `n`, in Boxy at most 6), `shape.dot(size)` (always
  a circle: legend dots, radio buttons), `shape.inner(outer, inset)` (the segments inside a segmented control stay concentric) and
  `shape.tailed(radius, tail, corner)` (the four corners of a chat bubble with its pointed corner).
  `useTheme()` returns the active scale as `radius` and the helpers bound to it as `shape`; both are memoised by (palette, corners).
- **Why radii are inline now.** A `StyleSheet.create({ card: { borderRadius: radius.lg } })` runs once at import time, so it cannot
  follow a setting. The static `radius` export of `theme/index.ts` is gone and every radius is applied in render:
  `const { radius, shape } = useTheme();` and `style={[styles.card, { borderRadius: radius.lg }]}`. To add a rounded element, do the
  same: pick the token (`radius.lg` cards and sheets, `radius.md` fields and rows, `radius.pill` buttons, chips and segmented
  controls, `radius.sm` small highlights and notes) or a helper, never a number. Keep ALL radii of one element in the same
  place: on the web an inline `borderRadius` beats a per-corner radius that comes from a `StyleSheet.create` class (inline style
  wins over a class), so the chat bubbles write all four corners inline with `shape.tailed(...)`. Keep flat style objects on the
  `TabTrigger` children in `app-nav.tsx`. Components that are not React components (pure helpers) get the radii as a parameter. Tiny round dots may keep a
  literal below 6 (`borderRadius: 5` for a 10 px dot); anything bigger goes through `shape`.
- **The guard.** `tools/ui-smoke/src/shape-guard.test.ts` reads every file under `apps/app/src` and fails when something outside `theme/`
  imports `radius` or a scale, writes `borderRadius:` with a literal of 6 or more (a short allowlist with reasons is the only way
  around it, currently empty) or writes a `999` radius. Together with `pnpm typecheck` (the old export is gone) nobody can bring a static
  round corner back by accident. The same file tests the scales and the helpers, including the old numbers of every converted component.
- **Outside React** (`chrome.ts`): on the web, `react-native-web` has no `Appearance.setColorScheme`, so the page gets the palette
  directly: CSS `color-scheme`, the body background, `<meta name="theme-color">` and the `--ct-primary` variable that the input focus
  ring in `lib/web-styles.ts` reads. On native, a pinned Light or Dark mode calls `Appearance.setColorScheme` (system dialogs and
  keyboards follow); Match system removes the override (`'unspecified'`), otherwise `useColorScheme()` would stop reporting the device.
  The status bar, the navigation theme and the native window background in `app/_layout.tsx` already derive from `useTheme()`.
- **Components use tokens, never raw brand colours.** Text on a coloured fill uses `onPrimary` / `onDanger` / `onWarning` / `onSuccess`;
  sheets dim the page with `withAlpha(colors.scrim, 0.45)`. The barcode scanner keeps fixed black and white over the camera.
- **Known limits:** the native splash screen and the app icon are static (`app.json` uses the Kanagawa Wave page colour); icons are not
  regenerated per palette. Real-device appearance is not verified.

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
- Edge functions require a signed-in user (except `sign-up`, which is gated by an invite code), have per-user, per-client and global rate limits, and use the service key only inside Supabase.
- Garmin has no server side at all: the phone signs in on Garmin's own page, keeps the token in its secure storage (never in Supabase), reads Garmin itself and saves the result through the normal owner-only tables.

## Decisions worth knowing

| Decision | Why |
| --- | --- |
| Expo + React Native Web, one codebase | One team of one; web, iOS and Android from the same screens |
| Supabase Free, no Docker | Zero cost; tests use PGlite instead of a local Supabase |
| `foods.nutrients` as JSON, not a row per nutrient | About 20x smaller; fits the 500 MB limit |
| Entries store grams, not copied nutrients; foods immutable once logged | Small database and stable history |
| AI picks foods and weights, the database supplies nutrients | LLM nutrient numbers are unreliable; matched numbers are auditable |
| Key on the device, calls straight to OpenRouter | No server holds anyone's key |
| Garmin is read by the phone itself (`packages/garmin`), next to Apple Health / Health Connect | Garmin's Developer Program (OAuth + webhooks) needs Garmin's approval. The phone signs in on Garmin's own page in a web view and then reads the same undocumented interface Garmin's own mobile app uses, with the user's token in secure storage: no server, no webhook, read-only, but unofficial, so it can break when Garmin changes it. Health sync stays the stable route and covers other watches |
| No over-the-air updates | Needs an Expo account; every change is a rebuild for now |

## Known limits

- Intake-table values and the nutrient ID mapping were written from memory and then partly checked against real USDA files; a
  full review against the NIH tables is still open.
- Food names are English (USDA, Canadian data); custom foods can use any language.
- Nothing has been run on real devices yet; see the [first-run checklist](getting-started.md).
