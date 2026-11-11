# @ration/ui-smoke

Visual / runtime smoke test for the Ration **web build**. It loads the real Expo web export in headless Chrome
against a **mocked Supabase backend**, walks through every screen at a phone and a desktop size, saves
screenshots and reports console errors, uncaught exceptions, blank screens, error text, failed requests and
backend calls the mock does not know.

Nothing in the app has to run for this: the harness opens **no socket**. Playwright's `context.route()` serves the
build from disk under `https://app.test` and answers `https://mock.supabase.test` from an in-process PostgREST /
GoTrue emulator. Every other request is aborted and listed in the report.

> **Needs a normal terminal.** Chrome cannot start inside the Optimus sandbox (no sockets / IPC). Everything that
> is pure Node (the mock backend, fixtures, scenario list, report) is covered by `pnpm --filter @ration/ui-smoke test`,
> which does run in the sandbox.

## Run

```bash
# one command: builds the web export, starts Chrome, writes screenshots + report
pnpm --filter @ration/ui-smoke smoke

# options
pnpm --filter @ration/ui-smoke smoke -- --skip-build            # reuse the last export
pnpm --filter @ration/ui-smoke smoke -- --only=diary            # scenarios whose name or path contain "diary"
pnpm --filter @ration/ui-smoke smoke -- --out=/tmp/my-run --viewports=phone,phone-dark   # dark mode is opt-in
pnpm --filter @ration/ui-smoke smoke -- --chrome="/Applications/Chromium.app/Contents/MacOS/Chromium"
pnpm --filter @ration/ui-smoke smoke -- --theme=dracula          # start the app with another palette (see below)
pnpm --filter @ration/ui-smoke smoke -- --corners=boxy           # start the app with the Boxy corners (see below)
pnpm --filter @ration/ui-smoke smoke -- --list                  # print scenarios + route coverage (no Chrome needed)
pnpm --filter @ration/ui-smoke smoke -- --headed --workers=1    # watch it
```

Other flags: `--dist=<dir>` (export directory, default `/tmp/cal-ui-smoke-dist`), `--console-errors=warn`
(downgrade `console.error` to WARN), `--timeout=<s>` (per run, default 120), `--workers=<n>` (parallel runs,
default 2), `--keep-cache` (do not pass `--clear` to `expo export`). Run `smoke -- --help` for the list.

`--theme=<paletteId>` seeds the app's saved theme choice (`localStorage['ration.theme.v1']`, the same init-script mechanism as
the session) before the app loads, so every scenario runs in that palette, for example `--theme=kanagawa-wave` or
`--theme=paper`. The choice is pinned to the palette's own side (mode `light` or `dark`), so `--viewports` and the browser's colour
scheme do not matter; the other side stays at its default. Without the flag nothing is seeded and the app starts with its default
(Match system, Kanagawa Lotus / Kanagawa Wave). Ids are listed by `--help`; an unknown id is an error. The scenario `settings:
appearance (theme picker)` starts by pressing *Reset to default*, so it also passes under `--theme`.

`--corners=rounded|boxy` seeds the corner style the same way (Boxy is the app's default, so without the flag the run is Boxy), so
the whole smoke can also run under the original look (`smoke -- --corners=rounded`, and `--theme=dracula --corners=rounded` for both). Alone it keeps Match system with the default palettes;
with `--theme` it adds the corners to that palette's choice. The theme picker scenario first checks the default (computed `border-top-left-radius` of the card around the *Appearance* heading is
8 px or less), presses *Rounded* and checks the saved choice (`"corners":"rounded"`) and a radius of 12 px or more, presses *Boxy*
and checks it is back to the small value, and ends with *Reset to default*, which also brings back Boxy corners; so it passes under
`--corners=rounded` too.

Chrome is looked up in this order: `--chrome`, `$CHROME_PATH`, `/Applications/Google Chrome.app/...`, Playwright's
own cache (`npx playwright-core install chromium`). The tool never downloads anything.

The export is built exactly like this (child process, cwd `apps/app`):

```bash
EXPO_NO_TELEMETRY=1 CI=1 EXPO_PUBLIC_SUPABASE_URL=https://mock.supabase.test \
EXPO_PUBLIC_SUPABASE_ANON_KEY=mock-anon-key npx expo export --platform web --clear --output-dir <dist>
```

### Output (default `/tmp/cal-ui-smoke`)

```
phone/001-sign-in-wrong-password-then-success.png        first screenshot after load
phone/001-...-after.png                                   after the scenario's interactions
phone/001-...-full.png                                    whole scroll height (viewport is stretched for this one)
desktop/...
report.json   report.md   build.log
```

`report.md` has a scenario x viewport table (`OK` / `WARN (n)` / `FAIL (n)`), the messages of every problem, the
unhandled backend endpoints, edge functions that were called, blocked external requests and harness warnings
(for example **routes without a scenario**). Exit code `1` when any run is `FAIL`.

| Result | When |
| --- | --- |
| FAIL | uncaught exception, `console.error` (see `src/known-noise.ts`), blank screen (< 20 visible characters), fatal error text (`Unmatched Route`, ...), failed `ctx.expect*`/`ctx.check`, a backend error that means a wrong query (unknown column, bad uuid, missing relationship, ...), a call the mock does not know, timeout |
| WARN | `console.warn`, failed `ctx.step` (usually a selector that needs adjusting), suspicious text (`NaN`, `undefined`, `Something went wrong`), handled backend errors (single() with no row, unique violation, ...), failed requests, blocked external requests, 404s from the build |
| OK | none of the above |

## How it works

| Module | Role |
| --- | --- |
| `src/run.ts` | CLI entry: build, launch Chrome, run all scenario x viewport jobs, write the report |
| `src/runner.ts` | one run = fresh browser context + fresh mock backend; listeners, screenshots, checks |
| `src/routing.ts`, `src/app-files.ts` | `context.route()` handler: app from disk (SPA fallback), backend from the mock, rest aborted |
| `src/mock-backend.ts`, `postgrest.ts`, `search.ts`, `schema.ts`, `session.ts` | the PostgREST / GoTrue emulator, derived from `supabase/migrations` |
| `src/fixtures.ts` | seed data (user, ~30 foods, 8 days of diary, 30 days of weight, ...) |
| `src/scenarios.ts` | **the list of scenarios** |
| `src/browser-scripts.ts` | JavaScript source strings run in the page (date shift, session seeding, inspection) |
| `src/theme-seed.ts`, `src/scenarios-theme.ts` | `--theme` / `--corners` seeding and the checks of the theme picker scenario (palettes and corner scales come from `apps/app/src/theme`) |
| `src/shape-guard.test.ts` | the corner scales, and the guard that keeps every rounded corner dynamic (no static `radius`, no big literal `borderRadius`) |

Design notes:

* **Fresh context per run.** localStorage, the persisted react-query cache and the backend data never leak from
  one scenario into the next, so assertions on `backend.mutations` are exact.
* **Time.** The page's `Date` is shifted so that "now" is `2026-11-10T12:00` in `Europe/Sarajevo`
  (`FIXED_NOW` in `src/constants.ts`) and keeps flowing; timers and animations stay real (a frozen clock would stall
  React Native's `Animated`). The fixtures derive every date from the same constant.
* **Session.** For `auth: 'signed-in'` the supabase-js session JSON is written to
  `localStorage['sb-mock-auth-token']` by an init script before any app code runs. The token is valid for ten
  years, so supabase-js accepts it without a network round trip and never tries to refresh it.
* **Fidelity of the mock.** Unknown columns, invalid uuids, CHECK / NOT NULL / FK / unique violations, RLS-like
  scoping, `ON DELETE CASCADE`, "UPDATE requires a WHERE clause" (Supabase enables pg-safeupdate), the
  `foods` immutability trigger and `daily_totals` (a view over the diary) behave like the real database, so a
  query that cannot work against `supabase/migrations` fails here too. Edge functions answer
  `404 {"code":"NOT_FOUND","message":"Requested function was not found","error":"not_deployed"}`, except `sign-up`
  (`src/signup-function.ts`): it validates with the real `parseSignUpRequest`, throttles after 5 attempts, and knows three
  invite codes (`SIGNUP_VALID_CODE` works once, `SIGNUP_EXPIRED_CODE`, `SIGNUP_USED_UP_CODE`). A successful call adds the user
  (with the profile and meal groups the signup trigger creates), so the following password grant works.
* **Contract tests.** `src/supabase-js-compat.test.ts` drives the **real** supabase-js client against the mock with
  the query chains of `apps/app/src/data`; `src/app-data-contract.test.ts` runs the app's own data functions
  (`lookupBarcode`, `fetchRecipeDetail`, `saveWeightGoalRow`, health `writer`, ...) against it;
  `src/grep-sync.test.ts` fails when the app uses a table / rpc / edge function the mock does not know.

## Add or change a scenario

Append an object to `SCENARIOS` in `src/scenarios.ts`:

```ts
{
  name: 'water: custom amount',            // unique; becomes the screenshot name
  route: '/water/new',                     // expo-router pattern (checked against apps/app/src/app)
  path: '/water/new',                      // or (fixtures) => `/food/${fixtures.ids.food.egg}`
  auth: 'signed-in',                       // or 'signed-out'
  fixtures: 'default',                     // 'imperial' | 'not-onboarded' | 'empty-diary' | 'fresh-account'
  expect: ["Today's total"],               // text that must be visible after load
  expectInputs: [],                        // input VALUES after load: [{ field: 'Food name', value: 'Ćevapi' }]
  allowBackendErrors: [],                  // expected 4xx, e.g. ['/auth/v1/token'] or /23505/
  allowConsole: [],                        // console messages to ignore for this scenario
  async after(page, ctx) {
    await stepThen(ctx, 'add 400 mL',
      async () => { await fill(page, 'Custom amount (mL)', '400'); await clickButton(page, 'Add custom amount', { exact: true }); },
      () => ctx.expectMutation('water_entries', 'insert', (m) => (m.payload as { ml?: number }).ml === 400));
  },
}
```

* `setup(page, ctx)` runs **before** navigation, `after(page, ctx)` after load + settle.
* `ctx.step(label, fn)` = an interaction (failure is a WARN), `ctx.expectText / expectInputValue / expectUrl /
  expectMutation / check` = assertions (failure is a FAIL), `ctx.snapshot(label)` = an extra screenshot,
  `ctx.backend` = the scenario's mock (`backend.mutations`, `backend.rows('diary_entries')`, `backend.calls`).
* Names such as "Ćevapi" on edit screens are input **values**, not page text: use `expectInputs` /
  `ctx.expectInputValue(field, value)`, never `expect` / `expectText`.
* `src/actions.ts` has the helpers: `fill(page, 'Label' | /placeholder/)` finds an input by aria-label (the app's
  `TextField` sets its label as aria-label), placeholder or the label text next to it, `clickButton`, `clickTab`
  (tab names are not upper-case: the visible capitals come from CSS), `choose`, `clickText`, `scrollToText`,
  `closeSheet` (closes a sheet through its scrim, which needs no keyboard focus and no timing; a sheet that stays
  open leaves a scrim that swallows every following click, so always close or assert it closed).
* The blank-screen check waits for the network to go idle and gives a nearly empty screen a few seconds to render
  before it fails, so a spinner that is still showing is not reported as blank.
* A new screen: add its scenario. The run prints `UNCOVERED ROUTE ...` for every route file without one, and
  `src/harness.test.ts` fails until you do.

Other extension points: `src/known-noise.ts` (console messages to ignore), `src/fixtures.ts` (data and
variants), `src/schema.ts` (new tables), `src/mock-backend.ts` (new RPCs).

## Known limits

* Camera: headless Chrome has no camera; `/scan` is tested through the manual barcode entry.
* AI screens are walked in their *gated* state (no OpenRouter key). OpenRouter requests are blocked and listed.
* Embedded-resource *filters* (`rel.col=eq.x`) and full-text operators are not emulated; the mock answers 400
  `MOCK_UNSUPPORTED` and lists the request under "Harness warnings".
* `output: "single"` export only (no per-route static HTML).
