// Edge Function: sign-up (Deno runtime). verify_jwt = false (see supabase/config.toml): the caller has no account yet, so there
// is no user JWT to verify. The invite code (consumed atomically in the database) and the rate limits below are the gate.
//
// POST { "email": string, "password": string, "inviteCode": string }
//   -> 201 { "ok": true }                                  account created (e-mail pre-confirmed); the app then signs in
//   -> 400 invalid_request | invalid_email | invalid_password | invalid_invite_code
//   -> 403 invite_invalid | invite_expired | invite_used_up | invite_revoked
//   -> 409 email_taken   -> 429 rate_limited   -> 500 internal_error
// Only wiring lives here; all logic is in ../_shared/signup.ts (pure TypeScript, unit-tested in Vitest).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handleHttp } from '../_shared/http.ts';
import { makeConsumeRateLimit } from '../_shared/rate-limit.ts';
import { clientKeyFromRequest, signUp } from '../_shared/signup.ts';
import {
  makeCreateUser,
  makeInviteStore,
  type SignUpAdminClient,
} from '../_shared/signup-store.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

// Service role: consumes invite codes, counts attempts and creates the user (auth.admin). Never leaves this function.
const admin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? (createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      }) as unknown as SignUpAdminClient)
    : null;

Deno.serve((req) =>
  handleHttp(
    req,
    async (body, request) => {
      if (!admin || !SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');
      }
      const invites = makeInviteStore(admin);
      return signUp(body, {
        consumeRateLimit: makeConsumeRateLimit(admin),
        consumeInvite: invites.consume,
        releaseInvite: invites.release,
        createUser: makeCreateUser(admin),
        // HMAC of the caller's address keyed with the service role key: the raw address is never stored or logged.
        clientKey: await clientKeyFromRequest(request, SUPABASE_SERVICE_ROLE_KEY),
        // Outcome kinds only: never the body, the code, the password or the address.
        log: (message, detail) => console.warn(`[sign-up] ${message}`, detail ?? ''),
      });
    },
    // Only the error message is logged (the Error object of a failed RPC is fine, a request body never is).
    (message, err) =>
      console.error(`[sign-up] ${message}`, err instanceof Error ? err.message : 'unknown'),
  ),
);
