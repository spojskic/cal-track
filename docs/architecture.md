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
2. **Expenditure for a day** ("Burned") is assembled from the parts below, and depends on the *energy mode*:
   `Burned = BMR + adjusted baseline activity + tracker activity + exercise (+ TEF)`. The baseline activity is a fraction of
   BMR chosen by the activity level; it is the allowance for everything that is not exercise and not measured, so at the
   start of the day `Burned = BMR + baseline` and meals can be planned before the watch recorded anything. It is then used up:
   - *static* and *device-adjusted* (`AWAKE_HOURS = 16`):
     `trackerActivity = max(0, deviceActive - deviceWorkoutKcal)` (watch movement outside workouts; 0 in static),
     `exercise = deviceWorkoutKcal + manualExerciseKcal` (manual only in static; net MET calories, because BMR already
     includes resting burn),
     `adjustedBaseline = max(0, baseline - trackerActivity - baseline / 16 * exerciseHours)`.
     Tracker activity replaces the baseline one for one, and every hour of exercise (watch workouts plus manual entries
     with a duration) removes one sixteenth of it, because you were not doing everyday movement then. Once both used it up the
     adjusted baseline is 0 and disappears from the breakdown.
   - *device total*: watch active + resting calories (+ TEF); no baseline.

   Example: BMR 1394, baseline 279, a 60 minute ride of 500 kcal -> adjusted baseline `279 - 279/16 = 261.5625`,
   `Burned = 1394 + 261.5625 + 500 = 2155.5625`.

   Watch workouts are stored with `counts_toward_energy = false` because they are already inside the watch's daily active
   total; they are not added again, they only split that total into tracker activity and exercise, supply exercise minutes,
   and cancel overlapping manual entries. Only the workouts of the source whose daily total is used are read (a session
   recorded by two apps is not counted twice). Without a daily total from the watch, device-adjusted behaves like static.

   The third circle of the energy summary has two views, switched by tapping its label (stored in
   `profiles.energy_summary_mode`): *Target* shows `(energy target + energy burned above the baseline) - consumed`
   (Remaining or Over), with `above baseline = max(0, adjusted baseline + tracker activity + exercise - baseline)`, e.g.
   `1673 + 482.5625` in the example above (with TEF on that burn is scaled up, see below). *Balance* shows `Burned (incl. TEF) - consumed`
   (Deficit or Surplus) and ignores the weight goal. The macro targets always use the energy target.

   **The floor is a minimum, not a bonus.** When the plan (`bmr + baseline + goal delta`) is below the minimum (1,500 men / 1,200
   women) the target is raised to it (`flooredBy`). Burned energy then only widens the budget once it has filled that gap:
   `budget = max(plan + above baseline, floor)`, in code `target + budgetExtraKcal(aboveBaseline, flooredBy, tefPct)`. Example (BMR 1835, no
   baseline, losing 0.5 kg/week = -550): plan 1285, target 1500, `flooredBy` 215; burning 934 above the baseline gives a budget of
   `1500 + 719 = 2219 = 1835 + 934 - 550`, exactly what the plan allows (adding all 934 would have given 2434, a smaller deficit than
   chosen). The energy bars of the diary and the dashboard compare what was eaten with this budget (`DayEnergy.exerciseBurnedKcal` is
   the widening), not the plain target; they used to compare eaten minus burned with the plain target, which showed 0% for a day
   with a big workout and a normal breakfast.

   **The target allows for the thermic effect of food.** With TEF on (`profiles.tef_enabled`, 10% of intake) the food you eat burns
   `tefPct` of itself, and the Expenditure and Balance views count that. The weight goal (-550 kcal/day for 0.5 kg/week) is a
   deficit against the burn WITH that TEF, so the plan is divided by `1 - tefPct`: `target = max((bmr + baseline + delta) / (1 - tefPct), floor)`
   (`computeEnergyTarget({ tefPct })`, `tefAllowance` is the part TEF adds) and every kcal burned above the baseline allows
   `1 / (1 - tefPct)` kcal of food (`budgetExtraKcal(aboveBaseline, flooredBy, tefPct)`). Eating exactly the budget then leaves the
   chosen deficit on the Balance view too. Without the division the target was 190 kcal too strict (target 1715 against an
   expenditure of 2459 and a 550 plan: 2459 - 550 = 1909, not 1715), and eating the target showed a deficit of 720 instead of 550.
   Example (BMR 1835, no baseline, -0.5 kg/week, TEF on): plan `1285 / 0.9 = 1427.8`, raised to the minimum 1500 (`flooredBy` 72.2);
   430 kcal burned above baseline gives a budget of `1500 + (430 / 0.9 - 72.2) = 1905.6 = (1835 + 430 - 550) / 0.9`, and eating it gives
   an expenditure of `1835 + 430 + 190.6 = 2455.6`, a deficit of exactly 550. `resolveTargets({ tefEnabled })` passes the flag
   (default off in the pure resolver; the app passes the profile's setting). The macro targets follow the energy target, so they are
   about 11% higher with TEF on.
3. **Per-entry nutrients** = food per-100 g amounts x grams / 100, then derived values (net carbs, omega-3/6, an energy
   fallback) honouring the food's carb convention. Day totals sum entries; unknown stays unknown.
4. **Nutrient targets** come from intake tables by age, sex and pregnancy/lactation, plus macro-driven targets, plus your overrides.

## Themes

The colours of every screen come from `useTheme()` in `apps/app/src/theme/`, which returns `{ colors, isDark, paletteId, corners, radius, shape }`.

- **Palette data is pure TypeScript** (no React Native import, so the Node tests can load it): `colors.ts` (the `ThemeColors` tokens,
  `withAlpha`, the original Ration look), `contrast.ts` (WCAG maths), `define-colors.ts` (derives each `on*` text colour, and the
  scrim, from the palette's own darkest and lightest inks), `palettes-light.ts` / `palettes-dark.ts` (22 palettes, all plain `#RRGGBB`
  because components append a 2-digit alpha to tokens) and `palettes.ts` (the registry, the defaults, the saved-choice rules and
  `resolvePalette`). `tools/ui-smoke/src/theme.test.ts` checks every palette for completeness and for contrast floors.
- **The choice is device-local**: `theme-store.ts` is a small zustand store
  (`{ mode: 'system' | 'light' | 'dark', light, dark, corners: 'rounded' | 'boxy' }`) saved under `ration.theme.v1` in AsyncStorage (localStorage on the web), like the AI preferences. An unknown or removed id falls
  back to the default of its side, a missing or unknown `corners` (a choice saved before the Boxy look existed) to the default, `boxy`, so the key
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
  `/add` ("Add to diary") is a full-screen card that slides up, not an iOS `modal`: a native modal gets iOS's own large rounded top
  edge, which the Boxy look cannot change (a `formSheet`, which takes a corner radius, rendered blank on an iPhone).
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

## Desktop shell (sidebar and status bar)

On a window of `WIDE_BREAKPOINT` (900 px) or more the app draws a **sidebar** at the left (248 px, `SIDEBAR_WIDTH`) and a thin **status
bar** along the bottom (`STATUS_BAR_HEIGHT`), around whatever screen is open. A phone never gets either: its bottom tab bar with the raised
**+** button and its More tab are unchanged.

- **Where it mounts, and why there.** `components/desktop/DesktopFrame.tsx` wraps the root `Stack` in `app/_layout.tsx`
  (`RootNavigator`). Only `index`, `diary`, `foods` and `more` live in the `(app)` tab layout; settings, workouts, coach, search, the
  food, recipe and saved meal pages, `add` and the rest are siblings in the root `Stack`. A sidebar inside `(app)` would disappear
  on all of those, so the frame sits above the navigator and is drawn once. It does not remount when the page changes. The navigator is
  always the same element in the same place (`sidebar | column(content, status bar)`, the other two are `null` when off), so crossing the
  breakpoint or opening a full-screen route never remounts it and loses its state; on a phone the three wrapper views are plain
  `flex: 1` containers.
- **When it is drawn** (`shouldShowDesktopShell` in `components/desktop/shell-routes.ts`, pure and unit tested): the window is wide, the
  user is signed in and has finished onboarding, and the path is not **`/sign-in`, `/onboarding` or `/scan`** (the barcode camera, which
  wants the whole window). The path comes from `usePathname()`, with groups stripped (`(auth)/sign-in` is `/sign-in`); matching is by whole
  segments. Everything else, `/add` included, is a screen of the shell. The result is also a React context
  (`useDesktopShell()` in `components/desktop/shell-context.tsx`): `StackHeader` and the `(app)` layout read it, so a wide window on a
  full-screen route looks as it does on a phone. `useContentWidth()` is the window width less the sidebar while the shell is on: screens
  that choose a layout by width (the coach's two panes, the food, recipe and saved meal pages' two columns) use it.
- **The `(app)` layout on a desktop** (`components/app-nav.tsx`) draws no sidebar of its own: it renders the routed page only. expo-router/ui
  builds the tab screens from the `TabTrigger` elements it finds in the `TabList`, so the four triggers (`index`, `diary`, `foods`,
  `more`) are still registered, in a `TabList` inside a `display: 'none'` view, each rendering `null`. Without them the routes would not be
  screens of the tabs. The rules in the file's comments still hold: the triggers are direct, inline children of `TabList`, and styles
  passed through `asChild` are flat objects. The `more` screen redirects to `/` on a desktop (`<Redirect href="/" />`), so an old link does
  not show a second copy of the menu; the phone's More page is untouched.
- **What the sidebar lists** (`components/desktop/sidebar-model.ts`, pure): **Daily** (Dashboard, Diary, Foods) and then the sections of
  the More screen, taken from `buildMoreSections` in `components/settings/more-sections.ts` so that labels, routes, icons and the AI row's
  On / Off badge are defined once: **Training**, **Coach**, **Profile**, **Connections**, **App**. The Account section is the pinned footer
  (the signed-in e-mail and **Sign out**), not a group. There is no More item. Below the groups is the collapsible **Calendar**
  (`SidebarCalendar.tsx`, date maths in `month-grid.ts`: six weeks, Monday first, dates built at noon from year / month / day so a time zone
  or a daylight-saving change cannot move a cell). A day sets `useSelectedDate` and opens `/diary`.
- **Active row.** `resolveActiveRowId(groups, pathname)` takes the row whose path (or `alsoActiveOn` prefix) is the longest match, by
  segments, so `/workouts/<id>` keeps Workouts lit, `/settings/targets` lights Profile & targets, `/settings/garmin-sign-in` lights
  Connected apps & devices, and `/food`, `/recipe` and `/saved-meal` pages light Foods. The add flows (`/add`, `/search`, `/scan`,
  `/ai/*`, `/exercise`, `/biometric`, `/note`, `/water`) belong to no page and light nothing. The lit row carries `aria-current="page"`.
- **Navigation.** A row is one `accessibilityRole="link"` named exactly like its label (the AI row adds its status: "AI (optional). Off"),
  its icon hidden from screen readers. `sidebarNavigation(current, target)` decides the call: the same page does nothing; from a tab to another
  tab or to a page that is not a tab it is `router.navigate` (switches the tab, or pushes the page); from a page that is not a tab back to
  a tab it is `router.dismissTo` (the `(app)` screen already in the stack is shown again: `navigate` would mount a second, hidden copy of
  the tabs and every query of the dashboard or diary would run twice); and from one page that is not a tab to another it is
  `router.replace`, so clicking through the sidebar swaps pages instead of piling them up (Back still leads to the tab below).
- **Collapsing.** Each group heading is a button named like the group with `aria-expanded`; the choice is kept in a zustand store
  (`sidebar-store.ts`, same pattern as `theme/theme-store.ts`) under the versioned key `ration.sidebar.v1` (read synchronously on the web,
  hydrated on native). `sidebar-state.ts` is the pure part: only known groups with a true / false value are kept, so an old, newer or
  garbage payload gives the defaults (every group open, the calendar closed).
- **Status bar** (`ShellStatusBar.tsx`, texts in `status-text.ts`). Left: "Syncing..." while the Apple Health / Health Connect or Garmin
  sync store says so, else "Synced just now / 12 min ago / today at 14:32 / yesterday at ... / on Oct 20" from the newest
  `integrations.last_sync_at` of a connected source, else "Not synced". The rows come from the same `useIntegration` hooks (query keys)
  the Connected apps & devices screen uses; nothing polls and nothing starts a sync. Right: "AI: on / off" (`useAiGate`), the colour theme's
  name and the app version (`expo-constants`).
- **Page header.** Inside the shell `StackHeader` is a slim strip of `PAGE_HEADER_HEIGHT` with a hairline underneath: a small back button
  when there is a page to go back to, the muted parent ("Settings", "Workouts", "Foods", from the route name) before the title, and
  `headerRight` at the right. The dashboard, diary and foods pages draw the same strip themselves (`PageHeader` in `components/panel.tsx`).
  The window's top inset is kept free once, by the frame, and not added again by the header or the tab slot.
- **Tests.** `tools/ui-smoke/src/desktop-shell.test.ts` covers the model, the active-row rules, the excluded routes, the navigation rule,
  the month grid, the collapse state and the status texts. The browser scenarios named `shell: ...` (and `more: a desktop window has no More
  page`, `sidebar: Workouts ...`) cover the real navigation. Not verified on a real device: the iPad / tablet case (safe-area insets).

## Desktop page layouts

The three tab pages have a second layout for a window of `WIDE_BREAKPOINT` (900 px) or more, beside the desktop sidebar. Each page
decides in its own file (`const wide = useWindowDimensions().width >= WIDE_BREAKPOINT`, the same switch as the app shell) and renders
either its phone code, untouched, or the desktop body; the desktop body is a separate component, so a phone never mounts it (and
`WorkoutsPanel`'s `useWorkouts` query only runs on the desktop dashboard).

- **Measurements** are shared with the shell in `theme/desktop.ts` (`SIDEBAR_WIDTH`, `PAGE_HEADER_HEIGHT`, `STATUS_BAR_HEIGHT`,
  `DESKTOP_CONTENT_MAX_WIDTH` 1440, `DESKTOP_CONTENT_PADDING` 20, `PANEL_GAP` 12, `PANEL_HEADER_HEIGHT` 34).
- **Pure rules** in `components/desktop-layout.ts` (no React Native, unit tested in `tools/ui-smoke/src/desktop-layout.test.ts`):
  `columnsFor` / `planGrid` (1 column below 760 px of content, 2 below 1120, 3 from 1120; a `columns` override), `packRows` (deals
  panels with their `span` into rows of at most `columns`), `kpiColumns` (cells per KPI row, balanced: six cells are 3 + 3, five 3 + 2),
  `planDiary` (stacked below 900 px, else a 58 : 42 split with the list at least 520 px), `estimateContentWidth` (first guess from the
  window so the first frame already has the right number of columns), `formatLongDate` and `textColumnWidth`. The numbers and texts of
  the dashboard (`macroBarRows`, `macroKpi`, `remainingKpi`, `streakMessage`, `weightStats`, `entriesMeta`) are in
  `components/diary/dashboard-view.ts`, tested in `dashboard-view.test.ts`.
- **Building blocks** in `components/panel.tsx`: `DesktopPage` (the `PageHeader` strip plus a scrolling, centred content column, or a
  fixed one for a page whose panes scroll on their own), `Panel` (1 px border, `radius.lg`, a title strip with title, `meta`, `action`
  or `headerRight` and a hairline; `flush` for lists, `tone="page"` for lists whose rows are drawn in the page colour, `collapsible`
  turns the title strip into a button), `PanelGrid` (rows of `flex: span` cells with `alignItems: stretch`, so panels of a row are
  equally tall and a short last row still fills the width; the columns come from its own measured width), `SplitPanes` (the diary's
  two panes), `KpiStrip` / `KpiCell` / `MiniProgress` (one bordered strip with hairline dividers that wraps by `kpiColumns`),
  `BarList` (label | bar | value | percentage, with the value columns as wide as their widest text so the bars line up),
  `PanelTabs` and `ToolbarButton`. Colours come from `useTheme().colors`, corners from `radius` / `shape` only (the shape guard
  applies), borders are 1 px, figures use `tabular-nums`.
- **Pages**: `components/diary/DashboardPanels.tsx` (`DesktopDashboard`), `components/diary/DiaryDesktop.tsx` +
  `NutrientPanels.tsx` (`DesktopDiaryBody`; `use-nutrient-model.ts` computes the score, highlights and nutrient groups once for the phone's
  `NutrientTargetsPanel` and the desktop panels), `components/food/FoodsDesktop.tsx`. The phone's cards (`DashboardCards.tsx`), pager
  and `DateBar` are unchanged; `DateControls` in `DateBar.tsx` is the same set of buttons in one row for the page header, with the same
  accessible names.
- **Smoke test**: on a desktop viewport the `dashboard`, `diary: flat layout` and `foods tab` scenarios check the panel headings and that
  the panels sit in columns across at least 80 % of the content area.

## Search and the free-tier budget

- Search runs in Postgres: unaccented full-text plus trigram matching, ranked by your history, then source quality, then text
  similarity. A private `SECURITY DEFINER` function does the indexed work and the public function re-checks row-level security
  (otherwise Postgres would scan the whole table on every keystroke).
- On the client one search serves two screens: the Foods tab (results in place) and the Add food screen (`app/search.tsx`). The rules
  (two-character threshold, what the results area shows, when the online card is offered) are pure functions in
  `components/food/food-search.ts` (unit tested in `tools/ui-smoke`); `use-food-search-results.ts` debounces and asks the server,
  `use-food-row-actions.ts` is what a row does (open, quick add, pick, import an online result), and `search-field.tsx` and
  `FoodSearchResults.tsx` draw the field and the answer.
- Only **generic** foods are bulk-imported. Branded and Open Food Facts products are fetched on demand and cached, which keeps
  the database near 50 MB instead of several GB.
- Meal photos are never stored. A weekly size check warns at 400 MB; a nightly workflow keeps 30 days of encrypted backups
  because the free plan has none.

## Security model

- The app ships only the Supabase URL and the anon key. All protection is row-level security (tested, including cross-user checks).
- Accounts are created by the owner, or by a friend with an invite code the owner generated (the `sign-up` Edge Function creates the account on the server); public sign-up stays off in Supabase.
- **Super admin**: `profiles.is_admin` (one boolean, default false) is what shows the Invite people screen and lets the `admin_*` RPCs
  (migrations 107 and 108) call the owner-only invite functions. The profile row is owner-writable through the Data API, so a trigger
  (`profiles_guard_admin_flag`, SECURITY INVOKER, keyed on `current_user` being `anon`/`authenticated`) refuses any client that sets or
  changes the flag; the SQL editor and `service_role` can. The RPCs check `private.is_super_admin()` themselves and raise 42501
  otherwise (also for `service_role`, which has no `auth.uid()`), so the screen is a convenience and the database is the gate. A test
  pins the list of SECURITY DEFINER functions that clients can call. Invite codes are made **for an e-mail address**
  (`private.invite_codes.invited_email`, lower-case, checked); nothing is sent, the column is the groundwork for e-mail invites later.
  The Invite people lists are paged by 20 with PostgREST (`admin_list_invites()` returns a table, so the app adds `status=eq.active`,
  `limit`, `offset` and `Prefer: count=exact`), not by loading every code.
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
