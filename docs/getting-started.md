# Getting started

From a fresh clone to a working app in the browser. Budget about 30 minutes, most of it waiting for downloads.
Everything here uses free tiers.

## 1. Prerequisites

- **Node 22.13 or newer** (`nvm install 22`; the repo has an `.nvmrc`) and **pnpm 11** (`corepack enable pnpm`)
- A free **[Supabase](https://supabase.com)** account
- Optional: a free **USDA API key** ([fdc.nal.usda.gov/api-key-signup](https://fdc.nal.usda.gov/api-key-signup)), only needed for
  branded-product barcode lookups
- Phone builds need more tools; see [install on devices](install-on-devices.md). Docker is **not** required.

## 2. Install and check the code

```bash
pnpm install
pnpm test          # core, ai, importer, database and smoke-harness tests, no accounts needed
pnpm typecheck
```

## 3. Create the Supabase project

1. In Supabase create a new project (Free plan). Note the **database password** you choose.
2. **Settings > API**: copy the *Project URL* and the *anon* key (newer dashboards call it the *publishable* key; either works).
3. Put them in the app's environment:

   ```bash
   cp .env.example apps/app/.env
   # edit apps/app/.env:
   #   EXPO_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
   #   EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon key>
   ```

   The anon key is public by design (it ships inside the app); row-level security protects the data. **Never** put the
   `service_role` key or the database password in `apps/app/.env`.

## 4. Create the schema and reference data

```bash
npx supabase login
npx supabase link --project-ref <ref>      # <ref> is the xxxx in https://xxxx.supabase.co
npx supabase db push --remote --include-seed   # migrations AND the seed files (CLI 3 needs --remote, else it targets a local Docker DB)
```

`--include-seed` also loads the reference data (nutrient list, intake targets, exercise activities) from `supabase/seed/`; the
files are idempotent, so re-running is safe. Regenerate them with `pnpm seed:generate` if you change the catalog. Use
`--dry-run` first to preview. Older CLIs (v2) have no `--remote`/`--include-seed`; then run the three seed files in the
SQL Editor yourself, in order (`001_nutrients.sql`, `002_dri_values.sql`, `003_exercise_activities.sql`).

## 5. Accounts

Sign-ups are meant to be closed (invite-only). In the dashboard:

1. **Authentication > Sign In / Providers**: turn off *Allow new users to sign up* (the label may differ slightly
   between dashboard versions), or run `npx supabase config push`.
2. **Authentication > Users > Add user > Create new user**: enter an email and a password and tick *Auto Confirm User*.
   Do this for each person. (The "Invite user" email flow does not work yet: the app has no set-password page.)

## 6. Load the foods

The importer needs a database connection string. In the dashboard click **Connect** and copy the **Session pooler** string
(it works over IPv4), insert your password, and export it for this terminal:

```bash
export SUPABASE_DB_URL='postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres'

pnpm --filter @cal/importer run import -- download sr_legacy        # about 6 MB
pnpm --filter @cal/importer run import -- download foundation
pnpm --filter @cal/importer run import -- download fndds
pnpm --filter @cal/importer run import -- all --dry-run             # parse only, prints sizes
pnpm --filter @cal/importer run import -- all                       # writes to the database
```

Expect about 7,800 SR Legacy foods, 400 Foundation foods and 5,400 survey (FNDDS) foods, roughly 35 to 50 MB in total
(the free plan allows 500 MB). Run `analyze public.foods;` in the SQL editor afterwards. More options (Canadian Nutrient
File, flags) are in the [importer guide](../tools/importer/README.md).

## 7. Run it

```bash
pnpm web
```

Sign in with a user you created, finish the onboarding wizard (body details, activity, goal), then log a food from the
**+** button. The first run is the first time the app talks to a real backend, so please report or fix anything odd.

## 8. Optional extras

| Want | Do |
| --- | --- |
| Barcode scanning and "Search online" | Deploy the edge functions: [supabase/functions/README.md](../supabase/functions/README.md) |
| AI features | Connect an OpenRouter key under **More > AI**: [AI and privacy](ai-and-privacy.md) |
| Phone apps and Apple Health / Health Connect | [Install on devices](install-on-devices.md) |
| Backups and keep-alive | Add the repository secrets listed at the top of `.github/workflows/db-backup.yml` and `keep-alive.yml` |

## Troubleshooting

- **"Connect your Supabase project" screen**: `apps/app/.env` is missing or still has the placeholder values. Restart the dev server
  after editing it; if it still shows old values, start with `pnpm --filter @cal/app exec expo start --web --clear`.
- **Sign-in says invalid credentials**: the user does not exist, or was created without *Auto Confirm User*.
- **Search finds nothing**: step 6 has not run, or `analyze public.foods;` was skipped on a big import.
- **"permission denied" / empty lists everywhere**: `supabase db push` did not complete; check the output for errors.
- **Saving a nutrient target or logging an exercise fails with a foreign-key error**: the seed files in step 4 were not loaded.
- **Importer cannot connect**: use the *Session pooler* string, not the direct connection (GitHub runners and many home networks have no IPv6).
