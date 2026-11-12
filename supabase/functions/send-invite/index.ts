// Edge Function: send-invite (Deno runtime). verify_jwt = true (see supabase/config.toml): the caller is the
// signed-in super admin of the Invite people screen.
//
// POST { "email": string, "maxUses"?: number, "validDays"?: number | null }
//   -> 201 { "code": "XXXX-XXXX-XXXX", "sent": true | false }
//      the code exists either way; sent=false means the e-mail could not go out and the screen falls back
//      to the copy flow that was there before
//   -> 400 invalid_request | invalid_email | invalid_max_uses | invalid_valid_days
//   -> 401 unauthorized   -> 403 not_admin   -> 429 rate_limited   -> 500 internal_error
// Only wiring lives here; all logic is in ../_shared/invite.ts (pure TypeScript, unit-tested in Vitest).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { apiError, handleHttp, callerFromRequest } from '../_shared/http.ts';
import { makeConsumeRateLimit } from '../_shared/rate-limit.ts';
import { sendInvite, type SendEmail } from '../_shared/invite.ts';
import { makeInviteAdminStore } from '../_shared/invite-store.ts';
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

// Service role: reads profiles.is_admin, creates the code, counts the throttle. Never leaves this function.
const admin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? (createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      }) as unknown as SupabaseLike)
    : null;

const log = (message: string, detail?: unknown) => console.warn(`[send-invite] ${message}`, detail ?? '');

// The e-mail goes out through Resend; without a key the function still creates the code and answers
// sent=false (the owner's copy flow is the fallback), and the outcome is logged without the address.
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
        return apiError(401, 'unauthorized', 'Sign in to invite people.');
      }
      return sendInvite(caller.userId, body, {
        consumeRateLimit: makeConsumeRateLimit(admin),
        isSuperAdmin: (userId) => makeInviteAdminStore(admin).isSuperAdmin(userId),
        createInviteCodeFor: makeInviteAdminStore(admin).createInviteCodeFor,
        sendEmail,
        ...(APP_URL ? { appUrl: APP_URL } : {}),
        log,
      });
    },
    // Only the error message is logged (the Error object of a failed RPC is fine, a request body never is).
    (message, err) =>
      console.error(`[send-invite] ${message}`, err instanceof Error ? err.message : 'unknown'),
  ),
);
