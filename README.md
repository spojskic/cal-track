# Cal Track

A Cronometer-style nutrition tracker for web, iOS and Android, built for a small group of users.
Tracks calories, macros and ~80 micronutrients, imports activity from Apple Health / Health Connect
(Garmin syncs into both), and has optional AI features (photo log, describe-a-meal, recipe builder,
health-only coach) that run on **your own OpenRouter key stored only on your device**.

> Status: feature-complete first version; needs its first real-world run (see "First-run checklist").

## Repository layout

| Path | What it is |
|---|---|
| `apps/app` | Expo SDK 58 app (Expo Router): one codebase for iOS, Android and web |
| `packages/core` | Pure TypeScript: nutrient catalog, BMR/energy maths, macro targets, DRI targets, recipes, scoring (Vitest-tested) |
| `packages/ai` | OpenRouter client, PKCE connect, meal/recipe parsing pipelines, coach with topic guard (Vitest-tested) |
| `supabase/` | Postgres migrations (schema, RLS, search RPC), config, edge functions |
| `tools/importer` | ETL that loads USDA FoodData Central + Canadian Nutrient File into Postgres |
| `tools/db-tests` | Database tests that run the real migrations in Postgres-in-WASM (PGlite), no Docker needed |
| `.github/workflows` | CI, nightly database backup, keep-alive, database size check |

## Prerequisites (macOS)

- Node 22.13+ (`nvm install 22`; `.nvmrc` is provided) and pnpm 11 (`corepack enable pnpm`)
- A free [Supabase](https://supabase.com) project
- For iOS device builds: Xcode (`sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`) and a free Apple ID
- For Android builds: Android Studio (open it once so it installs the SDK) and JDK 17
- Docker is **not** required

## Setup

```bash
nvm use            # Node 22
pnpm install
cp .env.example apps/app/.env   # then fill in the two EXPO_PUBLIC_* values
pnpm test          # runs core, ai, importer and database tests
pnpm web           # start the app in the browser (first target)
```

### Supabase

1. Create a project at supabase.com (Free plan is enough).
2. `npx supabase login`, then `npx supabase link --project-ref <ref>` and `npx supabase db push`.
3. Sign-ups are disabled (invite-only). Create each user in the dashboard under
   Authentication > Users > Add user (email + password, auto-confirm).
4. Generate and load the reference seeds (nutrients, intake targets, exercises):
   `pnpm seed:generate`, then run the three files in `supabase/seed/` in the SQL editor (or with `psql`)
5. Import foods: see `tools/importer/README.md`.

### GitHub Actions secrets

`SUPABASE_URL`, `SUPABASE_ANON_KEY` (keep-alive); `SUPABASE_DB_URL` (use the **session pooler**
string, GitHub runners have no IPv6) and `BACKUP_PASSPHRASE` (nightly encrypted backup, 30 days).

## Sideloading (no paid developer accounts)

- **Android:** build an APK and share the file (`eas build -p android --profile sideload` or a local Gradle release build).
- **iOS:** with a free Apple ID, build on your Mac (`npx expo run:ios --configuration Release --device`).
  Free signing expires after 7 days, so re-run weekly, or install an unsigned `.ipa` through SideStore/AltStore,
  which re-signs automatically. Sign in with Apple and push notifications are unavailable on free accounts,
  so the app uses email + password.
- **Web:** works on any device and can be added to the home screen. It has no Apple Health access.

## AI features

Optional. Connect your own OpenRouter key under More > AI (one-tap OAuth, or paste a key). All AI UI is
hidden unless the key validates **and** the selected model accepts images. The key never leaves your device.
Food photos and descriptions are sent to OpenRouter only; the AI identifies foods and portions, and
nutrient values come from this app's food database (AI-only estimates are clearly flagged).
Coach conversations are stored in Supabase and auto-deleted after 90 days (switchable in settings).

## First-run checklist

Everything below has been typechecked, unit-tested and bundled, but **not yet run against a real Supabase
project or on a device**. Do these in order; each step proves one more layer.

1. `pnpm test` and `pnpm typecheck` pass (no accounts needed).
2. Create the Supabase project, `npx supabase link`, `npx supabase db push`, `pnpm seed:generate` and run the three
   files in `supabase/seed/` (SQL editor). Create your user (Authentication > Users > Add user).
3. Import foods: `tools/importer/README.md` (start with `download sr_legacy`, then `fdc --dataset sr_legacy`).
4. `pnpm web`, sign in, finish onboarding, log a food. This is the first time the Supabase queries meet a real
   PostgREST; expect to fix a query or two (embedded selects are the likeliest).
5. Deploy the edge functions (`supabase/functions/README.md`) and try a barcode scan / "Search online".
6. Connect OpenRouter under More > AI (paste a key; the OAuth button may be rejected on a local dev port).
7. Phone builds: `npx expo prebuild`, then Xcode (free Apple ID) or `npx expo run:android`. Apple Health /
   Health Connect cannot be tested in a simulator or Expo Go. HealthKit's background-delivery entitlement is off by
   default because free Apple IDs may not be able to sign it.
8. `pnpm --filter @cal/ui-smoke smoke` runs the whole web app against a mocked backend and screenshots every screen
   (needs a normal terminal; see `tools/ui-smoke/README.md`).

## Roadmap

Done (code complete, see checklist for what still needs real-world verification):

- [x] Monorepo, CI, nightly backup, keep-alive, database size check
- [x] Nutrition maths: 92-nutrient catalog, BMR/energy modes, macros, intake targets, recipes, scoring
- [x] Supabase schema, RLS, accent-insensitive search, coach retention (230+ database tests on real Postgres)
- [x] Food importer for USDA FoodData Central (JSON + CSV) and Canadian Nutrient File
- [x] Onboarding, targets breakdown, nutrient target overrides, settings
- [x] Food search, food detail, custom foods, barcode scan, online search (edge functions)
- [x] Diary, energy/macro/nutrient summaries, dashboard
- [x] Exercise, biometrics, notes, water
- [x] Recipes with cooked-weight maths and versioning, saved meals
- [x] Apple Health / Health Connect sync
- [x] AI: OpenRouter connect, photo log, describe meal, AI recipe, health-only coach

Not built yet:

- [ ] Trends / reports page and CSV export
- [ ] Fasting timer
- [ ] UK CoFID import (needs the Excel layout)
- [ ] Garmin Personal API (direct Garmin data such as Body Battery)
- [ ] Mark-day-complete and swipe between days
- [ ] Writing nutrition back to Apple Health / Health Connect
