# Cal Track

A nutrition tracker in the style of Cronometer, for **web, iOS and Android**, built for you and a small group of
friends. It tracks calories, macros and about 90 nutrients, works out your daily targets from your body and goal,
and adds calories burned from Apple Health or Health Connect. Optional AI features (photo log, describe a meal,
recipe draft, a health-only coach) run on **your own OpenRouter key, which never leaves your device**.

> Status: all planned features are written and tested in isolation, but the app has **not yet had its first run
> against a real Supabase project or on a phone**. Expect to fix a few things on first contact. Use the
> [getting-started guide](docs/getting-started.md) and its checklist.

## What you get

- **Diary** with meal groups, water, exercise, notes and biometrics; calorie, macro and per-nutrient targets with bars and rings.
- **Food database** built from USDA FoodData Central (about 14,000 generic foods with full micronutrients) and optionally the
  Canadian Nutrient File, plus barcode lookup (USDA branded, Open Food Facts) and your own custom foods and recipes.
- **Targets that fit you**: BMR formulas, activity level, weight goal, macro modes (ratios, fixed, keto), intake targets by age and sex.
- **Device data**: Apple Health and Health Connect sync (Garmin and other wearables feed into those). The calorie budget can use
  your static estimate or your watch's numbers.
- **Optional AI**: photo log, describe a meal, AI recipe, and a coach that only talks health and training.
- **Private by design**: invite-only accounts, per-user row-level security, no ads, AI key stored only on the device.

Details: [docs/features.md](docs/features.md).

## Quick start

```bash
nvm install 22 && nvm use 22 && corepack enable pnpm
pnpm install
cp .env.example apps/app/.env     # fill in your Supabase URL and anon key
pnpm web                          # open the app in the browser
```

Before this works you need a (free) Supabase project with the schema and food data loaded.
The full walk-through is in **[docs/getting-started.md](docs/getting-started.md)**.

## Documentation

| Guide | What is in it |
| --- | --- |
| [Getting started](docs/getting-started.md) | Supabase setup, loading foods, first run, troubleshooting |
| [Install on devices](docs/install-on-devices.md) | Web hosting, Android APK, iOS with a free Apple ID, health permissions |
| [Features](docs/features.md) | What every screen does, and what is not built yet |
| [AI and privacy](docs/ai-and-privacy.md) | Connecting a key, what is sent where, coach limits, costs |
| [Architecture](docs/architecture.md) | Repo layout, data model, how targets and energy are computed, design decisions |
| [Development](docs/development.md) | Commands, tests, regenerating generated files, the browser smoke test |
| [Garmin: what to do](docs/garmin-setup-guide.md) | Step-by-step checklist: apply to Garmin, publish the policy, secrets, deploy, connect |
| [Garmin integration](docs/garmin-integration.md) | One-tap Connect Garmin: how it works, secrets, what to do after Garmin approves the app (ships switched off) |
| [Garmin access request](docs/garmin-application.md) | Ready-to-paste answers for Garmin's developer access form |
| [Privacy policy](docs/privacy-policy.md) | Plain-language policy to publish (Garmin asks for a public URL) |

Component guides: [database](supabase/README.md), [edge functions](supabase/functions/README.md),
[food importer](tools/importer/README.md).

## Good to know

- Not medical advice. The calorie and nutrient targets are estimates from published formulas and intake tables.
- Runs entirely on free tiers (Supabase Free: 500 MB database, no automatic backups; a nightly backup workflow is included).
- Sideloaded apps from a free Apple ID expire after 7 days; see [install on devices](docs/install-on-devices.md).
