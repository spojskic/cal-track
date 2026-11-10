// Edge Function: garmin-webhook (Deno runtime). verify_jwt = false (see supabase/config.toml): Garmin's servers call it and
// do not carry a Supabase JWT. Authentication is a shared secret (GARMIN_WEBHOOK_SECRET) checked in constant time, see
// ../_shared/garmin-oauth.ts presentedWebhookSecret() for where it may be sent (header or ?secret=).
//
// POST <Garmin push JSON>  ->  200 { ok, received, accepted, rejected, deregistered }
// Only wiring lives here; all logic is in ../_shared/garmin-flows.ts (pure TypeScript, unit-tested in Vitest).
import { createClient } from 'npm:@supabase/supabase-js@2';
import type { SupabaseLike } from '../_shared/food-store.ts';
import { handleWebhookRequest } from '../_shared/garmin-flows.ts';
import { readGarminConfig } from '../_shared/garmin-oauth.ts';
import { makeGarminStore } from '../_shared/garmin-store.ts';
import { apiError, jsonResponse } from '../_shared/http.ts';
import { makeConsumeRateLimit } from '../_shared/rate-limit.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const admin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? (createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      }) as unknown as SupabaseLike)
    : null;

Deno.serve(async (req) => {
  try {
    if (!admin) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');
    return jsonResponse(
      await handleWebhookRequest(req, {
        cfg: readGarminConfig((name) => Deno.env.get(name)),
        store: makeGarminStore(admin),
        fetch: (input, init) => fetch(input, init),
        consumeRateLimit: makeConsumeRateLimit(admin),
        // Never log the request URL (it may carry ?secret=) or payload values.
        log: (message, detail) => console.warn(`[garmin-webhook] ${message}`, detail ?? ''),
      }),
    );
  } catch (err) {
    // A 5xx makes Garmin retry the push; every write is idempotent, so a retry is safe.
    console.error(
      '[garmin-webhook] unhandled error',
      err instanceof Error ? err.message : 'unknown',
    );
    return jsonResponse(apiError(500, 'internal_error', 'Something went wrong. Please try again.'));
  }
});
