// Edge Function: friend-request (Deno runtime). verify_jwt = true (see supabase/config.toml): the caller is
// the signed-in user of the Friends screen.
//
// POST { "email": string }
//   -> 200 { "status": "sent" | "accepted" | "already_friends" | "already_requested" }
//      the same answers the Friends screen knows from public.send_friend_request; an e-mail without an
//      account answers sent too (nothing exists to tell the caller apart) and nobody is mailed
//   -> 400 invalid_request | invalid_email | own_email
//   -> 401 unauthorized   -> 429 rate_limited   -> 500 internal_error
// A request that was actually created also sends the addressee a mail (the notification); a failed mail does
// not fail the request.
// Only wiring lives here; all logic is in ../_shared/friend-request.ts (pure TypeScript, unit-tested in Vitest).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { apiError, handleHttp, callerFromRequest } from '../_shared/http.ts';
import { makeConsumeRateLimit } from '../_shared/rate-limit.ts';
import { friendRequest, type SendEmail } from '../_shared/friend-request.ts';
import { makeFriendRequestStore } from '../_shared/friend-request-store.ts';
import { makeSendEmail } from '../_shared/email-send.ts';
import type { SupabaseLike } from '../_shared/food-store.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
// Resend by default; a fullsend-style proxy can be put in front with RESEND_BASE_URL.
const RESEND_BASE_URL = Deno.env.get('RESEND_BASE_URL') ?? 'https://api.resend.com';
const APP_URL = Deno.env.get('APP_URL');
// Local dev: DRY_RUN_EMAIL=true logs the rendered e-mail instead of sending (see supabase/functions/README.md).
const DRY_RUN_EMAIL = Deno.env.get('DRY_RUN_EMAIL') === 'true';

// Service role: creates the request through send_friend_request_internal (the requester comes from the verified
// JWT), reads the sender's display name and counts the throttle. Never leaves this function.
const admin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? (createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      }) as unknown as SupabaseLike)
    : null;

const log = (message: string, detail?: unknown) => console.warn(`[friend-request] ${message}`, detail ?? '');

// The e-mail goes out through Resend; without a key the request still works and only the outcome is logged
// (a missing mail must never fail a friend request that exists in the database).
const sendEmail: SendEmail = RESEND_API_KEY
  ? (message) =>
      makeSendEmail(fetch, RESEND_BASE_URL, RESEND_API_KEY, { log })(message, { dryRun: DRY_RUN_EMAIL })
  : async (message) => {
      log('email_not_configured', { subject: message.subject });
      return { ok: false, reason: 'not_configured' };
    };

Deno.serve((req) =>
  handleHttp(
    req,
    async (body, request) => {
      const caller = callerFromRequest(req);
      if (!caller || !admin || !SUPABASE_SERVICE_ROLE_KEY) {
        return apiError(401, 'unauthorized', 'Sign in to send friend requests.');
      }
      return friendRequest(caller.userId, body, {
        consumeRateLimit: makeConsumeRateLimit(admin),
        sendRequestInternal: makeFriendRequestStore(admin).sendRequestInternal,
        displayNameOf: makeFriendRequestStore(admin).displayNameOf,
        sendEmail,
        ...(APP_URL ? { appUrl: APP_URL } : {}),
        log,
      });
    },
    // Only the error message is logged (the Error object of a failed RPC is fine, a request body never is).
    (message, err) =>
      console.error(`[friend-request] ${message}`, err instanceof Error ? err.message : 'unknown'),
  ),
);
