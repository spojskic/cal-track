// Edge Function: garmin-oauth-start (Deno runtime). verify_jwt = true (see supabase/config.toml).
// Only wiring lives here; all logic is in ../_shared/garmin-flows.ts (pure TypeScript, unit-tested in Vitest).
//
// POST { "platform": "native" | "web" }  ->  200 { "url": "<Garmin authorize page>" }
//                                         ->  503 { "error": "garmin_not_configured" } until GARMIN_CLIENT_ID is set
import { createClient } from 'npm:@supabase/supabase-js@2';
import type { SupabaseLike } from '../_shared/food-store.ts';
import { startOAuth } from '../_shared/garmin-flows.ts';
import { readGarminConfig } from '../_shared/garmin-oauth.ts';
import { makeGarminStore } from '../_shared/garmin-store.ts';
import { apiError, callerFromRequest, handleHttp } from '../_shared/http.ts';
import { makeConsumeRateLimit } from '../_shared/rate-limit.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

// Service role: used for the service-role-only garmin_* RPCs and consume_rate_limit.
const admin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? (createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      }) as unknown as SupabaseLike)
    : null;

Deno.serve((req) =>
  handleHttp(req, async (body, request) => {
    // verify_jwt = true already rejected invalid tokens; this refuses the anon key.
    const caller = callerFromRequest(request);
    if (!caller) return apiError(401, 'unauthorized', 'Sign in to use this function.');
    if (!admin) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');

    return startOAuth(body, caller.userId, {
      cfg: readGarminConfig((name) => Deno.env.get(name)),
      store: makeGarminStore(admin),
      fetch: (input, init) => fetch(input, init),
      consumeRateLimit: makeConsumeRateLimit(admin),
      log: (message, detail) => console.warn(`[garmin-oauth-start] ${message}`, detail ?? ''),
    });
  }),
);
