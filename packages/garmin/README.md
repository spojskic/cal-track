# @cal/garmin

Pure TypeScript client, mappers and sync walk for **Garmin's own mobile-app interface** (`connectapi.garmin.com`), as used by the
Cal Track phone app. **Read-only**, runs on the user's phone with a token the user got by signing in on Garmin's own page.
Only `fetch`, timers and `AbortController` are used, so it runs on Node 22 and React Native (Hermes). The package's `main` is
`src/index.ts` and is consumed directly as TypeScript source.

> **Unofficial.** This is the same undocumented interface Garmin's own mobile app uses, copied from the reference project
> `garmin-companion` (`crates/garmin-core/src/{auth,client,sync,sleep}.rs`, `crates/garmin-api/src/session.rs`,
> `apps/mobile/src/data/ticket.ts`). It needs no Garmin developer approval and can break whenever Garmin changes it.
> Nothing is ever written to Garmin: the reference's one write method (`create_workout`) is **not** ported.

## What is in here

| file | job |
| --- | --- |
| `session.ts` | `SIGN_IN_URL`, `ticketIn(url)` (https garmin.com hosts only), `createTicketGate()` (only the first ticket counts) |
| `auth.ts` | `buildRefreshRequest`, `buildTicketExchangeRequest`, `refreshTokens(fetch, tokens)`, `redeemServiceTicket(fetch, ticket)` |
| `tokens.ts` | `GarminTokens`, JWT `exp` reading, `isTokenExpired` (120 s early-refresh skew) |
| `client.ts` | `GarminConnectClient`: GET-only, 401 -> refresh once, 429/5xx backoff, one request at a time, 250 ms apart |
| `mappers.ts` | Connect JSON -> the rows the app writes (`GarminDailyEnergy`, `GarminWorkout`, `GarminBiometric`) with diagnostics |
| `sync.ts` | `runGarminSync`: which endpoints, in which order, what stops a run; hands data to `onBatch` as it arrives |
| `report.ts` | `formatSyncReport`: the plain-text "sync report" (no values, no tokens); `formatDetailReport`: its "Workout details" section |
| `workout-details.ts` | the versioned shape of `exercise_entries.details` (`v: 1`), `parseWorkoutDetails` (tolerant), `needsGarminDetails` (when to read) |
| `activity-mappers.ts` | one activity: the list summary (`detailsFromListItem`), the summaryDTO, the heart-rate zones, the strength sets, the laps |
| `activity-details.ts` | `fetchActivityDetails`: the four per-activity GET calls in order, with the sync's failure policy; `DetailStats` for the report |
| `pick.ts`, `dates.ts`, `jwt.ts`, `base64.ts`, `http.ts`, `errors.ts` | tolerant pickers, date math, helpers, typed errors with token redaction |

## Safety properties (all covered by tests)

- **GET only for data.** The client has one method per endpoint and no generic "send"; `assertReadOnly` refuses any non-GET and any
  URL outside `https://connectapi.garmin.com/` right before `fetch`. The only POST in the package is the token endpoint
  (refresh and the first ticket exchange), in `auth.ts`.
- **No parallel bursts.** Every call goes through one queue; requests start at least 250 ms apart (`REQUEST_SPACING_MS`), also the
  token refresh. 429 / 5xx / dropped connections: three attempts, 1 s then 3 s apart, a `Retry-After` header wins (capped at 30 s).
- **A dead session stops the run.** HTTP 400 / 401 from the refresh = `session_dead`; a 401 that survives a fresh token =
  `unauthorized`; a 429 = `rate_limited`; a dropped network and a failed token save also end the run. A 404 / 403 / 204 / empty
  body is "no data" (HRV on a night the watch was not worn), not a problem.
- **No state, no storage, no global fetch.** `fetch`, the clock and `sleep` are injected. A refreshed token pair (the refresh token may
  rotate) is handed to `onTokensChanged`, which must persist it; a failing save ends the request with a `storage` error.
- **No secrets in errors or reports.** `GarminError` scrubs access/refresh tokens, JWTs, `Bearer ...` headers and tickets in its constructor;
  error bodies and response bodies are never copied into messages; the sync report prints key *names* and counts only.

## Usage

```ts
import { GarminConnectClient, formatSyncReport, redeemServiceTicket, runGarminSync, ticketIn, SIGN_IN_URL } from '@cal/garmin';

// 1. show SIGN_IN_URL in a web view; stop the navigation that carries a ticket:  const t = ticketIn(request.url)
// 2. tokens = await redeemServiceTicket(fetch, t)   // once; keep the pair in secure storage
// 3. read a range
const client = new GarminConnectClient({ fetch, tokens, onTokensChanged: save });
const outcome = await runGarminSync({
  client,
  range: { from: '2026-11-01', to: '2026-11-10' },        // the user's local calendar days, inclusive
  onBatch: async (batch) => write(batch),                  // { energy[], workouts[], biometrics[] } as each step finishes
});
// outcome.status: 'complete' | 'stopped' (see outcome.report.stop) | 'cancelled'
const text = formatSyncReport(outcome.report, { generatedAtMs: Date.now() }, outcome.counts);
```

Rows are the shapes the app already writes for health data (`apps/app/src/health`): `source = 'garmin'`, ids such as
`garmin:activity:<id>`, `garmin:sleep:<day>`, `garmin:weight:<samplePk>`. A day's calories and steps are **running totals**: a later
read of the same day replaces the earlier one, it is never added.

## Endpoints (all GET, all on `https://connectapi.garmin.com`)

| endpoint | used for |
| --- | --- |
| `/userprofile-service/socialProfile` | `displayName` (needed in two paths) |
| `/usersummary-service/usersummary/daily/{displayName}?calendarDate=` | active / resting / total kcal, steps, resting HR, stress, body battery |
| `/wellness-service/wellness/dailySleepData/{displayName}?date=&nonSleepBufferMinutes=60` | sleep hours, stages, score, SpO2, respiration, overnight HRV |
| `/hrv-service/hrv/{date}` | overnight HRV average |
| `/weight-service/weight/dateRange?startDate=&endDate=` | weigh-ins (grams), body fat |
| `/activitylist-service/activities/search/activities?start=&limit=` | workouts with calories and duration (and heart rate, zones, training effect: stored as a `summary`) |
| `/activity-service/activity/{id}` | one workout: `summaryDTO` (heart rate, distance, speed, climb, calories, training effect) |
| `/activity-service/activity/{id}/hrTimeInZones` | time in each heart-rate zone |
| `/activity-service/activity/{id}/exerciseSets` | strength sets (strength-like sessions only) |
| `/activity-service/activity/{id}/splits` | laps (everything that is not strength-like) |

## What is verified and what is a guess

Field names marked VERIFIED in `FIELD_CANDIDATES` (`src/mappers.ts`) were read from the reference's Rust structs and parsing; they are the
first candidate of each list. The others (nested Personal-API names, `startTimeGMT`, `timestampGMT`, `elapsedDuration`, the un-nested sleep
names) are guesses, tried only after the verified name. The mappers never throw, never invent a value (absent stays absent, never 0), and
report which JSON key matched which field and which fields matched nothing (`coverage`, `diagnostics`) - that is what the app's
"Copy sync report" button prints. **No real Garmin payload and no live request was available when this was written.**

Workout details (`workout-details.ts`, `activity-mappers.ts`): VERIFIED names are `averageHR`, `maxHR`, `averageSpeed`, `calories`,
`aerobicTrainingEffect`, `anaerobicTrainingEffect`, `elevationGain`, `hrTimeInZone_1..5` (activity list), `zoneNumber` / `secsInZone` /
`zoneLowBoundary` (hrTimeInZones), `exerciseSets[].setType / duration / repetitionCount / weight (grams) / exercises[].category /
probability` and `lapDTOs[].lapIndex / distance / duration / averageHR / maxHR / elevationGain`. GUESSES: every name inside `summaryDTO`
(it is expected to repeat the list names), `activityTypeDTO.typeKey`, `minHR`, `trainingEffect`, `bmrCalories` (active calories =
calories - bmrCalories). The per-activity endpoints are the part no real reply was available for.

## Tests

`pnpm --filter @cal/garmin test`. Every `fetch` is a fake and the real global `fetch` is stubbed to throw, so the suite can never reach Garmin.
