/**
 * Shared constants of the smoke harness. Everything that must agree between the Playwright routing,
 * the mock backend, the pre-seeded browser session and the tests lives here.
 */

/** Fake origin the built web app is served from (https => secure context: crypto.subtle, IndexedDB...). */
export const APP_ORIGIN = 'https://app.test';

/** Fake Supabase origin; `EXPO_PUBLIC_SUPABASE_URL` at build time. */
export const BACKEND_ORIGIN = 'https://mock.supabase.test';

/** `EXPO_PUBLIC_SUPABASE_ANON_KEY` at build time. */
export const ANON_KEY = 'mock-anon-key';

/**
 * supabase-js stores the session under `sb-<first label of the URL hostname>-auth-token`
 * (SupabaseClient.ts: `sb-${baseUrl.hostname.split('.')[0]}-auth-token`).
 */
export const STORAGE_KEY = `sb-${new URL(BACKEND_ORIGIN).hostname.split('.')[0]}-auth-token`;

/** The browser's "now". Local noon on the diary date; the browser context uses {@link TIMEZONE}. */
export const FIXED_NOW = '2026-11-10T12:00:00';

/** Time zone of the browser context and of the fixture profile (CET, UTC+1 in November: no DST). */
export const TIMEZONE = 'Europe/Sarajevo';

/** Fixed offset used to turn FIXED_NOW into an epoch (valid for the whole of November). */
export const FIXED_UTC_OFFSET = '+01:00';

/** FIXED_NOW as epoch milliseconds (local noon in {@link TIMEZONE}). */
export const FIXED_NOW_MS = Date.parse(`${FIXED_NOW}${FIXED_UTC_OFFSET}`);

/** The diary "today" (YYYY-MM-DD) that corresponds to FIXED_NOW. */
export const TODAY = FIXED_NOW.slice(0, 10);

/** Env the web export is built with (see README). */
export const BUILD_ENV = {
  EXPO_NO_TELEMETRY: '1',
  CI: '1',
  EXPO_PUBLIC_SUPABASE_URL: BACKEND_ORIGIN,
  EXPO_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
  // The harness mocks the edge functions, so the online lookups are switched on in the test build.
  EXPO_PUBLIC_ONLINE_LOOKUP_ENABLED: 'true',
} as const;
