# Garmin Connect integration

A one-tap **Connect Garmin** button (Garmin Connect Developer Program, *Starter* tier: OAuth2 with PKCE and **push**
webhooks). It ships **dormant**: nothing Garmin related is visible or called until Garmin approves the app, the secrets below
are set and the app is built with `EXPO_PUBLIC_GARMIN_ENABLED=true`.

> **Status.** Written without access to Garmin's specification (it sits behind the developer portal after approval). Every
> endpoint, parameter and payload field below is an *assumption*; each one can be changed with a secret or in one small
> function. Read [TO CONFIRM AGAINST GARMIN'S DOCS AFTER APPROVAL](#to-confirm-against-garmins-docs-after-approval) before the
> first real connect. Related: [application answers](garmin-application.md), [privacy policy](privacy-policy.md).

The old *Personal API* client (`packages/garmin`, `tools/garmin-probe`) is **developer-only** (a key that one person keeps in an
environment variable). No screen in the app lets anyone paste a key.

## How it works

```
 App (Settings > Connected Apps & Devices)                         Garmin                    Supabase Edge Functions
 ───────────────────────────────────────────                       ──────                    ───────────────────────
 1. tap "Connect Garmin"  ── functions.invoke ───────────────────────────────────────────▶   garmin-oauth-start (JWT)
                                                                                              PKCE verifier+challenge, random state,
                                                                                              state row (10 min, single use)
    ◀──────────────────────────────────── { url: https://apis.garmin.com/tools/oauth2/authorizeUser?...&state=..} ──
 2. open url (web: location.assign; phone: openAuthSessionAsync)
                                         user signs in and consents ───▶ Garmin
 3.                                      Garmin redirects the BROWSER ──────────────────▶   garmin-oauth-callback (no JWT)
                                         .../garmin-oauth-callback?code=..&state=..          consume state (single use, TTL),
                                                                                              POST token endpoint (code + verifier),
                                                                                              GET user-id endpoint,
                                                                                              upsert the connection (tokens)
    ◀──────────────────────── 302 caltrack://settings/integrations?garmin=connected  (web: APP_URL/settings/integrations?...)
 4. the card shows "Connected" (rpc garmin_connection_status)

 5. the watch syncs with Garmin Connect  ───▶ Garmin POSTs the user's data ─────────────────▶   garmin-webhook (shared secret)
                                                                                              buffer (trimmed) in garmin_push_events,
                                                                                              map -> daily_energy / exercise_entries /
                                                                                              biometrics with source = 'garmin'
 6. user taps Disconnect ── functions.invoke ───────────────────────────────────────────▶   garmin-disconnect (JWT)
                                                           ◀── DELETE registration ──────      deregister at Garmin (best effort),
                                                                                              ALWAYS delete connection + tokens
    user removes the app in their Garmin account ───▶ Garmin POSTs { deregistrations } ───▶   garmin-webhook: delete connection + tokens
                                                                                              (+ imported Garmin data, see below)
```

Pushes are **push only**: Garmin sends data when the watch syncs, **starting from the moment of connecting**. There is no
history import; Garmin data for earlier days is not available (keep Apple Health / Health Connect sharing on for those).

## What was added

| Area | File | Purpose |
| --- | --- | --- |
| Database | `supabase/migrations/20261110000013_garmin_integration.sql` | tables, status RPC, service-only RPCs, `apply_garmin_health()` |
| Database | `supabase/migrations/20261110000090_pg_cron_supabase_only.sql` | (appended block) daily `purge_garmin_data()` schedule |
| Functions | `supabase/functions/garmin-oauth-start`, `-oauth-callback`, `-webhook`, `-disconnect` | thin Deno wiring |
| Functions | `supabase/functions/_shared/garmin-flows.ts` | the four flows, all I/O injected (unit-tested) |
| Functions | `_shared/garmin-oauth.ts`, `garmin-push.ts`, `garmin-store.ts`, `garmin-http.ts` | PKCE/config/redirects/secret compare, push -> rows mapper, RPC adapters, body reader |
| Config | `supabase/config.toml` | `verify_jwt`: true for start/disconnect, **false** for callback/webhook |
| App | `apps/app/src/health/garmin.ts`, `data/garmin.ts`, `components/health/GarminCard.tsx`, `app/settings/integrations.tsx` | flag, hooks, card |
| Tests | `tools/db-tests/src/garmin.test.ts`, `edge-garmin-*.test.ts`, `app-garmin.test.ts` | schema/privileges, mapper, OAuth helpers, flows against the real migration |

### Database

All three tables are in the **`private`** schema (never exposed through the Data API), have RLS enabled with **no policies**, and
`REVOKE ALL FROM public, anon, authenticated`. Edge Functions reach them only through `SECURITY DEFINER` RPCs with a fixed
`search_path` whose `EXECUTE` is granted to `service_role` only (the same pattern as `consume_rate_limit`).

| Object | Content |
| --- | --- |
| `private.garmin_connections` | `user_id` (PK, cascade), `garmin_user_id` (unique), `access_token`, `refresh_token`, `expires_at`, `refresh_expires_at`, `scopes`, `connected_at`, `last_push_at`, `last_error` |
| `private.garmin_oauth_states` | `state` (PK), `user_id`, `code_verifier`, `return_kind` (`native`/`web`), `created_at`; single use, 10 min TTL, purged after 1 h |
| `private.garmin_push_events` | raw push buffer: `user_id`, `garmin_user_id`, `kind`, `payload` (trimmed jsonb), `received_at`, `processed_at`, `error`. **14 days retention** |
| `public.garmin_connection_status()` | the only thing the app reads: `connected`, `connected_at`, `last_push_at`, `last_error` of `auth.uid()`. `SECURITY INVOKER` wrapper over `private.garmin_connection_status()`; never a token |
| `public.apply_garmin_health(user, energy, exercises, biometrics)` | service role only; `SECURITY INVOKER`; one transaction |
| `public.purge_garmin_data()` | oauth states > 1 h, push events > 14 days; scheduled daily by pg_cron **and** called by the webhook now and then |
| `public.garmin_oauth_state_create/consume`, `garmin_connection_save/get/touch/delete`, `garmin_push_events_record/finish` | service-role RPCs used by the functions |

Deleting a user (`auth.users`) cascades to all of it. If the Supabase-only migration `…90` was applied before this change,
`supabase db push` will not run its new block: paste that `do $$ … $$` block into the SQL editor once (the webhook purges
opportunistically in the meantime).

### Where the data goes (and how it avoids double counting)

Rows are written with `source = 'garmin'` into the **existing** tables, with the same conflict keys as the Apple Health /
Health Connect sync. The app already prefers a `garmin` energy row over the other sources for the same day
(`pickDeviceEnergy`: one device row per day, so nothing is summed across sources).

| Push kind | Table | Conflict key | Notes |
| --- | --- | --- | --- |
| `dailies` | `daily_energy` | PK `(user_id, local_date, 'garmin')` | `active_kcal`, `resting_kcal` (= `bmrKilocalories`), `steps`. **Cumulative**: upserted with `GREATEST()` so repeated / out-of-order pushes never add up or roll back |
| `dailies` | `biometrics` | `(user_id,'garmin', external_id)` | `resting_heart_rate`, `stress`, `body_battery` (nested shape only: the flat Health-API dailies have no daily high) |
| `sleeps` | `biometrics` | same | `sleep` (hours asleep, stages and score in `meta`), plus night `spo2` and `respiration_rate` when present |
| `activities` | `exercise_entries` | partial unique `(user_id,'garmin', external_id)` | `external_id = garmin:activity:<activityId>` (same as the pull mapper); `counts_toward_energy = false` (already inside the day's active energy) |
| `bodyComps` | `biometrics` | same | `weight` (kg), `body_fat` (percent), `external_id` includes the measurement time |
| `hrv` | `biometrics` | same | last night's average, ms |
| `stressDetails` | `biometrics` | same | `body_battery` day high/low/latest from the time-offset samples |

`external_id` values are `garmin:<type>:<date>` (daily values) – exactly the scheme of `packages/garmin`, so a later pull or
backfill de-duplicates against pushes. Biometrics only replace a stored value when the new `recorded_at` is not older (the end
of the summary window), so a late old push cannot undo a newer one. Other kinds (`userMetrics`, `epochs`, …) are **stored raw**
(trimmed, `error = 'unmapped_kind'`) and otherwise ignored, which also lets you look at the real format.

Partial-day safety, end to end:

1. The mapper passes the pushed day-so-far numbers on as they are (never a delta); a `0` counter is stored as *unknown*.
2. `apply_garmin_health()` keeps the largest value per counter (`GREATEST`; a missing value never erases one).
3. The **energy budget** treats today's device numbers as incomplete, see below.

### Energy budget audit (partial days)

* `static` mode ignores the watch. `device_adjusted` reads only the device's **active** energy (above the app's own baseline),
  never resting or total, so a half day can only *under*-count and there is nothing to double count.
* **Bug found and fixed in `device_total`**: it used the device's resting energy as the day's BMR. A Garmin shows e.g. 801
  resting kcal at midday, so today's expenditure was reported as ~950 instead of a day-sized number (and the same applies to the
  Apple Health / Health Connect resting figure of the current day). Now `computeExpenditure` takes `deviceDayComplete`
  (`packages/core/src/energy.ts`): while the device row's day is not finished, the resting part is
  `max(app BMR, device resting so far)`, i.e. the device figure is treated as the lower bound it is; the active energy so far is
  still counted. A day is finished when it is before today **and** the row was last written after the day ended
  (`isDeviceDayComplete`, using `daily_energy.updated_at`), so a day the watch has not synced since the evening also counts as
  not finished. Neither case ever adds the device resting energy on top of the app's BMR/baseline/manual exercise
  (covered by `packages/core/src/energy.test.ts`).

## Setup, in order

### 1. Anytime (before approval): deploy the dormant backend

```bash
npx supabase db push
npx supabase functions deploy garmin-oauth-start garmin-oauth-callback garmin-webhook garmin-disconnect
```

Without secrets the functions answer `503 {"error":"garmin_not_configured"}`. `verify_jwt` comes from `config.toml` (start and
disconnect require a signed-in user; callback and webhook cannot, Garmin calls them). **Do not use `--no-verify-jwt`** for
start/disconnect.

### 2. After Garmin approves the app

1. In Garmin's developer portal create the app and note the **client id** and **client secret**.
2. Set the secrets (never commit them; `SUPABASE_URL` and the service key are injected by Supabase):

   ```bash
   npx supabase secrets set \
     GARMIN_CLIENT_ID=... GARMIN_CLIENT_SECRET=... \
     GARMIN_WEBHOOK_SECRET="$(openssl rand -hex 24)" \
     APP_URL=https://your-web-app.example.com
   ```

3. Fill in the **portal settings** (`<SUPABASE_URL>` = `https://<project-ref>.supabase.co`):

   | Portal field | Value |
   | --- | --- |
   | OAuth redirect / callback URL | `<SUPABASE_URL>/functions/v1/garmin-oauth-callback` |
   | Push endpoint, **every** enabled data type (daily summaries, activities, sleep, body composition, HRV, stress details) | `<SUPABASE_URL>/functions/v1/garmin-webhook?secret=<GARMIN_WEBHOOK_SECRET>` (or send the secret in the header `x-garmin-webhook-secret` if the portal allows custom headers) |
   | Deregistration endpoint | the same webhook URL (the body contains `deregistrations`) |
   | User permission change endpoint (if asked) | the same webhook URL (stored raw, not acted on) |
   | Delivery | **push** (JSON), not ping |

   Supabase function logs include request URLs, so the secret in `?secret=` is readable by project members; rotate it with
   `supabase secrets set GARMIN_WEBHOOK_SECRET=...` plus the portal fields if that matters.
4. Confirm the open points below, then **connect once yourself** and watch `private.garmin_push_events` (see *Checking it works*).
5. Build the app with `EXPO_PUBLIC_GARMIN_ENABLED=true` (`apps/app/.env`); the flag is baked in at build time. Web users need
   `APP_URL` on the server; phone builds use the deep link `caltrack://settings/integrations` (`GARMIN_APP_REDIRECT`).

### Secrets and environment

| Name | Where | Required | Default | Purpose |
| --- | --- | --- | --- | --- |
| `GARMIN_CLIENT_ID` | function secret | to start OAuth | – | start returns 503 `garmin_not_configured` without it |
| `GARMIN_CLIENT_SECRET` | function secret | to finish OAuth | – | token exchange |
| `GARMIN_WEBHOOK_SECRET` | function secret | for the webhook (≥ 16 chars) | – | shared secret, constant-time compare; webhook answers 503 without it |
| `APP_URL` | function secret | for web users | – | origin of the hosted web app, return target after the callback |
| `GARMIN_REDIRECT_URI` | function secret | no | `<SUPABASE_URL>/functions/v1/garmin-oauth-callback` | must equal the portal's redirect URL |
| `GARMIN_APP_REDIRECT` | function secret | no | `caltrack://settings/integrations` | deep link for phone returns (scheme in `apps/app/app.json`) |
| `GARMIN_AUTHORIZE_URL` | function secret | no | `https://apis.garmin.com/tools/oauth2/authorizeUser` | UNVERIFIED |
| `GARMIN_TOKEN_URL` | function secret | no | `https://diauth.garmin.com/di-oauth2-service/oauth/token` | UNVERIFIED |
| `GARMIN_USER_ID_URL` | function secret | no | `https://apis.garmin.com/wellness-api/rest/user/id` | UNVERIFIED |
| `GARMIN_DEREGISTER_URL` | function secret | no | `https://apis.garmin.com/wellness-api/rest/user/registration` | UNVERIFIED |
| `GARMIN_SCOPES` | function secret | no | none | space separated; omitted from the authorize request when unset |
| `GARMIN_TOKEN_AUTH_STYLE` | function secret | no | `body` | `body` (client id/secret in the form) or `basic` (HTTP Basic) |
| `GARMIN_DELETE_DATA_ON_DEREGISTER` | function secret | no | `true` | `false` keeps imported Garmin rows when Garmin reports a deregistration (the link, tokens and raw buffer are always deleted) |
| `EXPO_PUBLIC_GARMIN_ENABLED` | app build env | to show the card | `false` | `true` renders the card and enables the status query |

## Behaviour details

* **Start**: per-user rate limit (10/min). Body `{ "platform": "native" | "web" }`. `web` needs `APP_URL`. Returns `{ url }`.
* **Callback**: global rate limit (60/min). Never trusts anything but the stored `state`: the user comes from our row, the return
  target from secrets (no open redirect). Failure reasons are short codes (`access_denied`, `token_exchange_failed`,
  `user_id_failed`, `account_already_linked`, …) which the app turns into text. Supabase serves HTML from functions as plain
  text, so the callback only ever answers a `302` (or a plain-text error when the state is unknown). Tokens, codes, verifiers and
  secrets are never logged.
* **Webhook**: POST only; secret from the header, `Authorization: Bearer`, or `?secret=`; wrong secrets get `401` (failed attempts
  are rate limited globally: 30/min). Body up to 5 MB, gzip understood. Unknown Garmin users are counted in `rejected` and not
  stored, but the answer is still `200` (so Garmin does not disable the endpoint over a user we no longer have). Everything is
  buffered first, then mapped; a failure while applying still answers `200` and leaves `error = 'apply_failed'` on the events
  and `last_error` on the connection (the app shows it); a failure to *buffer* answers `5xx` so Garmin retries (all writes are
  idempotent). Two to four RPC round trips per user and push, far below any response deadline.
* **Deregistration**: deletes the connection, tokens, pending states and the raw buffer of that user; the imported Garmin rows
  are deleted too unless `GARMIN_DELETE_DATA_ON_DEREGISTER=false`.
* **Disconnect**: asks Garmin to drop the registration (one token refresh and retry on `401`), **always** deletes the local link,
  and with `deleteData: true` also the imported `source = 'garmin'` rows. Never touches Apple Health / Health Connect rows.
* **Account in use**: a Garmin account can be linked to one Cal Track user only.

## Checking it works

```sql
-- what Garmin really sends (kinds, how many, how recent, errors)
select kind, count(*), max(received_at) as last, count(*) filter (where error is not null) as with_error
from private.garmin_push_events group by kind order by last desc;

-- the real payload of the latest pushes (large sample maps are trimmed to a few entries)
select id, kind, error, jsonb_pretty(payload) from private.garmin_push_events order by id desc limit 5;

-- what ended up in the diary tables
select local_date, active_kcal, resting_kcal, steps, updated_at from public.daily_energy where source = 'garmin' order by local_date desc limit 7;
```

Run these in the Supabase SQL editor (project owner). `error = 'unmapped_kind'` marks kinds the mapper does not use;
`dailies: no calendarDate / start time` style errors mean a field name is different from the assumption.

## Tests

```bash
pnpm --filter @cal/db-tests test      # schema + privileges + RPCs, mapper, OAuth helpers, flows against the real migration
pnpm --filter @cal/core test          # energy model incl. partial-day device energy
```

Not covered: the Deno runtime itself and the four thin `index.ts` files, real Garmin responses, a real browser/OAuth round trip.

## TO CONFIRM AGAINST GARMIN'S DOCS AFTER APPROVAL

Everything here was written **without** Garmin's Starter-tier documentation. Each item is marked `// UNVERIFIED:` in the code
(`grep -rn UNVERIFIED supabase/functions`). Check them in the portal docs and fix the listed place.

| # | Assumption | Where | If wrong |
| --- | --- | --- | --- |
| 1 | Authorize page `https://apis.garmin.com/tools/oauth2/authorizeUser` with `response_type=code`, `client_id`, `redirect_uri`, `code_challenge` + `code_challenge_method=S256`, `state` (+ optional `scope`) | `garmin-oauth.ts` `buildAuthorizeUrl` | `GARMIN_AUTHORIZE_URL`, `GARMIN_SCOPES`, or edit the builder |
| 2 | The redirect URI sent equals the portal's (`<SUPABASE_URL>/functions/v1/garmin-oauth-callback`) and Garmin accepts it as is | `readGarminConfig` | `GARMIN_REDIRECT_URI` |
| 3 | Token endpoint `https://diauth.garmin.com/di-oauth2-service/oauth/token`, form POST with `grant_type=authorization_code`, `code`, `code_verifier`, `redirect_uri`, `client_id`, `client_secret` | `buildTokenRequest` | `GARMIN_TOKEN_URL`; client authentication via HTTP Basic: `GARMIN_TOKEN_AUTH_STYLE=basic` |
| 4 | Token response fields `access_token`, `refresh_token`, `expires_in`, `refresh_token_expires_in`, `scope`; lifetimes unknown; refresh uses `grant_type=refresh_token` | `parseTokenResponse` | edit the parser |
| 5 | A GET with `Authorization: Bearer <access token>` on `https://apis.garmin.com/wellness-api/rest/user/id` returns `{"userId": "…"}` and that id is the one used in pushes | `DEFAULT_USER_ID_URL`, `parseGarminUserId` | `GARMIN_USER_ID_URL`, parser |
| 6 | Pushes identify the user by `userId` (also accepted: `garminUserId`, `user_id`); older Health-API style pushes carry `userAccessToken` instead (looked up against the stored access token, which only matches until the token rotates) | `extractPushItems`, `handleWebhookRequest` | adapt `USER_ID_KEYS` / the lookup |
| 7 | **Push, not ping**: the Starter tier POSTs the data itself. A *ping* (body with only `callbackURL`s) is detected and recorded as `ping_payload_without_data` but **not** fetched | `handleWebhookRequest` | a ping client (GET the callback URL with the user's token) would have to be added |
| 8 | Body = JSON object whose keys are data kinds holding arrays of per-user items: `dailies`, `sleeps`, `activities`, `stressDetails`, `bodyComps`, `hrv`, `deregistrations` (aliases such as `dailySummaries`, `bodyCompositions` are accepted; anything else is stored raw) | `KIND_ALIASES` in `garmin-push.ts` | add the real names |
| 9 | Item fields, flat (old Health API): `calendarDate`, `startTimeInSeconds`, `startTimeOffsetInSeconds`, `durationInSeconds`, `activeKilocalories`, `bmrKilocalories`, `steps`, `restingHeartRateInBeatsPerMinute`, `averageStressLevel`; sleeps `deep/light/remSleepDuration…`, `overallSleepScore.value`, `timeOffsetSleepSpo2/Respiration`; activities `activityId`, `activityName`, `activityType`, `activeKilocalories`; bodyComps `weightInGrams`, `bodyFatInPercent`, `measurementTimeInSeconds`; stressDetails `timeOffsetBodyBatteryValues`; hrv `lastNightAvg`. Nested v2 (as the Personal API returned on a real account): `calories.burnedActive`, `movement.steps.value`, `heartRate.restingValue`, `stress.avgLevel`, `bodyBattery.*`, `sleepScores.overall.value`, … | `F`, `S` tables and the `map*` functions in `garmin-push.ts` | fix the candidate names; the stored raw events show the real ones |
| 10 | `dailies` are **cumulative for the day** and pushed repeatedly; `bmrKilocalories` (resting) is the day-so-far figure too, not a whole-day estimate | `mapDailies`, `apply_garmin_health`, energy model | if resting is a whole-day figure the energy fix is merely conservative |
| 11 | `calendarDate` is the user's local day (for sleeps: the day the sleep ended); `*OffsetInSeconds` is local minus UTC | `itemDate`, `localDateOf` | adjust date derivation |
| 12 | Units: weight in **grams**, body fat/water in percent, durations in seconds, kcal as numbers | mappers | adjust |
| 13 | How pushes are authenticated: no signature is checked; the secret is sent in the URL query or a header. Garmin may instead document IP ranges, a signature header or Basic auth | `presentedWebhookSecret` | implement the documented scheme |
| 14 | Delivery rules: a `200` is what Garmin wants (any body), non-2xx are retried, maximum payload/response time, optional gzip | `handleWebhookRequest`, `readRequestText` | adjust limits / status codes |
| 15 | Deregistration: `DELETE https://apis.garmin.com/wellness-api/rest/user/registration` with the user's bearer token; `deregistrations: [{userId, userAccessToken}]` pushes when the user revokes access in Garmin; maybe also `userPermissionsChange` | `DEFAULT_DEREGISTER_URL`, `deregisterAtGarmin` | `GARMIN_DEREGISTER_URL`, adapt |
| 16 | Which data types the Starter tier offers and which scopes/permissions the user is asked for | application + portal | request only what the app maps |
| 17 | Garmin's brand / attribution rules (logo, "Garmin Connect" wording, data attribution in the UI) – not implemented | UI | add what the guidelines require before launch |
| 18 | Whether pushes can arrive out of order, duplicated or for days before the connection (handled defensively: idempotent upserts, `GREATEST`, `recorded_at` guard) | `apply_garmin_health` | – |

Quick way to settle 6–12: connect once, let the watch sync, and read `private.garmin_push_events` (query above).
