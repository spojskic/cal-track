// Edge Function: online-search (Deno runtime).
// Only wiring lives here; all logic is in ../_shared/ (pure TypeScript, unit-tested in Vitest).
import { createClient } from 'npm:@supabase/supabase-js@2';
import type { SupabaseLike } from '../_shared/food-store.ts';
import { apiError, callerFromRequest, handleHttp } from '../_shared/http.ts';
import { DEFAULT_SEARCH_LIMITS, onlineSearch } from '../_shared/online-search.ts';
import { makeConsumeRateLimit } from '../_shared/rate-limit.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

// Service role: only used to call consume_rate_limit (EXECUTE is granted to service_role only).
const admin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? (createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      }) as unknown as SupabaseLike)
    : null;

/** Optional integer env override (secrets: ONLINE_SEARCH_USER_PER_MINUTE / ONLINE_SEARCH_GLOBAL_PER_MINUTE). */
function intEnv(name: string, fallback: number): number {
  const n = Number.parseInt(Deno.env.get(name) ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

Deno.serve((req) =>
  handleHttp(req, async (body, request) => {
    const caller = callerFromRequest(request);
    if (!caller) return apiError(401, 'unauthorized', 'Sign in to use this function.');
    if (!admin) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');

    return onlineSearch(body, {
      fetch: (input, init) => fetch(input, init),
      env: {
        FDC_API_KEY: Deno.env.get('FDC_API_KEY'),
        OFF_USER_AGENT: Deno.env.get('OFF_USER_AGENT'),
      },
      userId: caller.userId,
      consumeRateLimit: makeConsumeRateLimit(admin),
      limits: {
        perUser: intEnv('ONLINE_SEARCH_USER_PER_MINUTE', DEFAULT_SEARCH_LIMITS.perUser),
        global: intEnv('ONLINE_SEARCH_GLOBAL_PER_MINUTE', DEFAULT_SEARCH_LIMITS.global),
        windowSeconds: DEFAULT_SEARCH_LIMITS.windowSeconds,
      },
      log: (message, detail) => console.warn(`[online-search] ${message}`, detail ?? ''),
    });
  }),
);
