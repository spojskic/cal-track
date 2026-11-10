# @cal/garmin

> **Developer-only.** This package and `tools/garmin-probe` talk to the *Personal API* with a key that one person pastes into an
> environment variable. **No app screen offers a paste-a-key flow**, and none should be added: users connect Garmin with the
> one-tap OAuth button (Garmin Connect Developer Program, push webhooks), documented in
> [`docs/garmin-integration.md`](../../docs/garmin-integration.md). What this package is still good for: confirming real
> response shapes (its mappers are verified against a real account, see `tools/garmin-probe`) and a possible future pull-based
> backfill. The push mapper of the OAuth integration lives in `supabase/functions/_shared/garmin-push.ts` (Edge Functions cannot
> import workspace packages) and deliberately uses the same biometric types, units and external ids as the mappers below, so pushed and
> pulled rows de-duplicate.

Pure TypeScript client for the **Garmin Connect Personal API** (read-only, pull-only, one person's own data). Only `fetch`, timers and `AbortController` are used, so it runs on Node 22 and React Native (Hermes). The package's `main` is `src/index.ts` and is consumed directly as TypeScript source.

## Terms and platform constraints

- The Personal API key belongs to one person. Garmin's terms forbid sharing it with third parties and say the API is "not intended for commercial applications serving multiple end users". **The key must stay on the user's own device** (SecureStore / encrypted storage). Never send it to, or store it on, a server.
- Browsers cannot call the API: the CORS preflight is answered with 403 and no CORS headers. It works from native apps and Node only. The web build of the app must not offer this integration.
- Keys start with `GCDC_` and expire after the period chosen at creation (30, 90, 180 or 365 days). The key is exchanged (`POST .../personal-api-key/token`, header `Authorization: ApiKey <key>`) for a bare JWT valid 24 h; there are no refresh tokens, the client simply exchanges the key again when less than 60 minutes remain. Data calls use `Authorization: Bearer <jwt>`.
- Limit is about 100 requests per minute. The client keeps itself under 90 per rolling minute and honours HTTP 429 `retryInSeconds` (capped at 60 s, two retries).
- No error message, `userMessage`, log event or serialisation produced by this package contains the key or a token (redaction is enforced in the `GarminError` constructor and covered by tests).

## Usage

```ts
import { createGarminClient, fetchGarminData } from '@cal/garmin';

const client = createGarminClient({ apiKey }); // apiKey read from on-device secure storage

const check = await client.validate(); // never throws
if (!check.ok) return show(check.error.userMessage);
// check.displayName, check.tokenExpiresAtMs

const result = await fetchGarminData(client, {
  from: '2026-11-01',
  to: '2026-11-09', // user's local calendar days, inclusive
  include: { energy: true, workouts: true, weight: true, bodyFat: true, restingHr: true, hrv: true,
             spo2: true, respiration: true, sleep: true, bodyBattery: true, stress: true },
  onProgress: (p) => setProgress(p.completedRequests / p.plannedRequests),
});
// result.energy[]     { date, activeKcal?, restingKcal?, totalKcal?, steps? }
// result.workouts[]   { externalId, name, typeKey, startMs, endMs, durationSec, kcal?, distanceM? }
// result.biometrics[] { date, type, value, unit, externalId, recordedAtMs?, meta? }
// result.errors[]     non-fatal failures (the rest of the sync completed)
// result.diagnostics[] / coverage[]  what the mappers could not find
```

Auth problems (bad, expired or revoked key; a 401 that survives a fresh token) reject with a `GarminError` and abort the sync. Everything else is collected in `errors`. Per-day fallbacks (daily heart rate, SpO2) are off by default: pass `fallbacks: { perDayEndpoints: true }` to enable them.

## What is unverified

Request paths, headers, limits and status codes come from Garmin's official documentation and client. **Response shapes are not verified** (no key was available): the field names in `FIELD_CANDIDATES` (`src/mappers.ts`) are educated guesses, and the mappers are deliberately tolerant (several candidate names, numeric strings, missing fields stay absent, never 0). Whatever they cannot find is reported in `diagnostics`. Run `tools/garmin-probe` with a real key to confirm the field names. Weight is assumed to be grams (a value above 1000 is converted to kg).
