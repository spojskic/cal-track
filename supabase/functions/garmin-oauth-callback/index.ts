// Edge Function: garmin-oauth-callback (Deno runtime). verify_jwt = false (see supabase/config.toml): Garmin sends the
// user's BROWSER here, which carries no Cal Track session. The user is identified by the single-use `state` we stored when
// garmin-oauth-start ran, never by anything else in the URL.
//
// GET ?code=...&state=...  ->  302 to the app (…/settings/integrations?garmin=connected | ?garmin=error&reason=<code>)
// Only wiring lives here; all logic is in ../_shared/garmin-flows.ts.
import { createClient } from 'npm:@supabase/supabase-js@2';
import type { SupabaseLike } from '../_shared/food-store.ts';
import { finishOAuth } from '../_shared/garmin-flows.ts';
import { redirectResponse, textResponse } from '../_shared/garmin-http.ts';
import { readGarminConfig } from '../_shared/garmin-oauth.ts';
import { makeGarminStore } from '../_shared/garmin-store.ts';
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
  if (req.method !== 'GET') return textResponse(405, 'Method not allowed.');
  try {
    if (!admin) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');
    const result = await finishOAuth(new URL(req.url).searchParams, {
      cfg: readGarminConfig((name) => Deno.env.get(name)),
      store: makeGarminStore(admin),
      fetch: (input, init) => fetch(input, init),
      consumeRateLimit: makeConsumeRateLimit(admin),
      // Never log the request URL: it carries the authorization code and state.
      log: (message, detail) => console.warn(`[garmin-oauth-callback] ${message}`, detail ?? ''),
    });
    return 'redirect' in result
      ? redirectResponse(result.redirect)
      : textResponse(result.status, result.message);
  } catch (err) {
    console.error(
      '[garmin-oauth-callback] unhandled error',
      err instanceof Error ? err.message : 'unknown',
    );
    return textResponse(500, 'Something went wrong. Return to Cal Track and try again.');
  }
});
