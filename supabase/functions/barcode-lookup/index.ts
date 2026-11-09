// Edge Function: barcode-lookup (Deno runtime).
// Only wiring lives here; all logic is in ../_shared/ (pure TypeScript, unit-tested in Vitest).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { barcodeLookup } from '../_shared/barcode-lookup.ts';
import { makeLocalLookup, makeUpsertFood, type SupabaseLike } from '../_shared/food-store.ts';
import { apiError, callerFromRequest, handleHttp } from '../_shared/http.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };

// Service-role client: reused by every request of this isolate. It is only used
// for the upsert RPC and never receives user input as SQL.
const admin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? (createClient(
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY,
        clientOptions,
      ) as unknown as SupabaseLike)
    : null;

Deno.serve((req) =>
  handleHttp(req, async (body, request) => {
    // verify_jwt = true already rejected invalid tokens; this refuses the anon key.
    const caller = callerFromRequest(request);
    if (!caller) return apiError(401, 'unauthorized', 'Sign in to use this function.');
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !admin) {
      throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are not set');
    }

    // User-scoped client: RLS applies to the local lookup.
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      ...clientOptions,
      global: { headers: { Authorization: `Bearer ${caller.token}` } },
    }) as unknown as SupabaseLike;

    return barcodeLookup(body, {
      fetch: (input, init) => fetch(input, init),
      localLookup: makeLocalLookup(userClient),
      upsertFood: makeUpsertFood(admin),
      env: {
        FDC_API_KEY: Deno.env.get('FDC_API_KEY'),
        OFF_USER_AGENT: Deno.env.get('OFF_USER_AGENT'),
      },
      log: (message, detail) => console.warn(`[barcode-lookup] ${message}`, detail ?? ''),
    });
  }),
);
