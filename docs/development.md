# Development

## Everyday commands

Run from the repository root with Node 22 (`nvm use`).

| Command | What it does |
| --- | --- |
| `pnpm install` | install everything (esbuild's build script is already approved in `pnpm-workspace.yaml`) |
| `pnpm web` / `pnpm dev` | start the app in the browser / the Expo dev server for phones |
| `pnpm test` | all unit and database tests through Turborepo |
| `pnpm typecheck` | TypeScript across every package |
| `pnpm --filter @ration/app lint` | ESLint with the Expo config (includes the React Compiler rules) |
| `pnpm seed:generate` | rewrite `supabase/seed/*.sql` from the catalog in `packages/core` |
| `node --import tsx packages/core/scripts/generate-edge-nutrient-map.ts [--check]` | regenerate (or verify) the nutrient map used by the edge functions |
| `pnpm --filter @ration/importer run import -- <cmd>` | food importer, see its [guide](../tools/importer/README.md) |
| `pnpm --filter @ration/ui-smoke smoke` | browser smoke test against a mocked backend, see its [guide](../tools/ui-smoke/README.md) |

Scripts use `node --import tsx file.ts` rather than the `tsx` command, because that also works in locked-down environments that
forbid local sockets.

## Tests

| Layer | Where | Covers |
| --- | --- | --- |
| Pure logic | `packages/core`, `packages/ai`, `tools/importer` (Vitest) | formulas, targets, recipes, OpenRouter client, topic guard, importer mapping |
| Database | `tools/db-tests` (Vitest + PGlite) | every migration, row-level security, search ranking, triggers, seeds, edge-function SQL |
| Browser | `tools/ui-smoke` (Playwright + Chrome) | every route renders without errors at phone and desktop sizes |
| Devices | manual | HealthKit, Health Connect, camera, real OpenRouter and USDA/Open Food Facts responses |

The first three need no accounts. The last row is the [first-run checklist](getting-started.md).

## Changing things

**Add or change a nutrient**: edit `packages/core/src/nutrients.ts`, run `pnpm --filter @ration/core test`, then `pnpm seed:generate`
and the edge map generator above, then `pnpm --filter @ration/db-tests test`. Commit the generated files together with the change.
Computed nutrients (net carbs, omega-3/6) are never stored.

**Change the schema**: add a new migration file in `supabase/migrations` (name it with a timestamp later than the existing ones;
anything that needs real Supabase, such as pg_cron, goes in a file with `supabase_only` in its name and comes last). Make it
idempotent, add or update a test in `tools/db-tests`, run the suite, then `npx supabase db push`. Never edit a migration that
has already been pushed.

**Add a screen**: create the route under `apps/app/src/app`, put data access in a hook under `apps/app/src/data`, and put logic
that needs tests in `packages/core` or `packages/ai`. Add the route to `tools/ui-smoke/src/scenarios.ts`; the smoke test warns when
a route is missing.

## Conventions

- **Units**: everything is stored metric (grams, kg, cm, ml, kcal) and converted only for display (`units.ts` in core).
- **Unknown is not zero**: a missing nutrient key stays missing through every sum; show a dash.
- **Query keys** are defined in `apps/app/src/data/keys.ts`. Everything that belongs to one diary day sits under
  `['day', date, part]`, so `invalidateDay` refreshes it all after a change.
- **React Compiler is on**: derive values instead of copying them into state inside effects, and do not change variables
  during render. ESLint enforces both.
- **Foods are immutable once logged**: never update `nutrients` on a logged food; use `supersede_food`.
- **AI code never touches the key directly**: use `useAiClient()`, which returns `null` while the gate is closed.
- **Commits**: one per feature or fix, in the style `feat(area): ...`, `fix(area): ...`.

## CI and automation

`.github/workflows`: `ci.yml` (typecheck, tests, web export on every push), `db-backup.yml` (nightly encrypted dump of user data,
30 days), `keep-alive.yml` (twice weekly ping so the free project does not pause), `db-size-check.yml` (weekly size warning at
400 MB). Required repository secrets are listed at the top of each file.
