// Edge Function: garmin-disconnect (Deno runtime). verify_jwt = true (see supabase/config.toml).
// Only wiring lives here; all logic is in ../_shared/garmin-flows.ts (pure TypeScript, unit-tested in Vitest).
//
// POST { "deleteData"?: boolean }  ->  200 { "ok": true, "deregistered": boolean }
// Tells Garmin to drop the registration (best effort) and ALWAYS deletes the local connection and tokens.
import { createClient } from 'npm:@supabase/supabase-js@2';
import type { SupabaseLike } from '../_shared/food-store.ts';
import { disconnectGarmin } from '../_shared/garmin-flows.ts';
import { readGarminConfig } from '../_shared/garmin-oauth.ts';
import { makeGarminStore } from '../_shared/garmin-store.ts';
import { apiError, callerFromRequest, handleHttp } from '../_shared/http.ts';
import { makeConsumeRateLimit } from '../_shared/rate-limit.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const admin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? (createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      }) as unknown as SupabaseLike)
    : null;

Deno.serve((req) =>
  handleHttp(req, async (body, request) => {
    const caller = callerFromRequest(request);
    if (!caller) return apiError(401, 'unauthorized', 'Sign in to use this function.');
    if (!admin) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');

    return disconnectGarmin(body, caller.userId, {
      cfg: readGarminConfig((name) => Deno.env.get(name)),
      store: makeGarminStore(admin),
      fetch: (input, init) => fetch(input, init),
      consumeRateLimit: makeConsumeRateLimit(admin),
      log: (message, detail) => console.warn(`[garmin-disconnect] ${message}`, detail ?? ''),
    });
  }),
);
