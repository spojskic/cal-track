/**
 * Invite by e-mail (pure: all I/O is injected; web-standard APIs only, no Deno globals).
 *
 * The pure handler behind the `send-invite` Edge Function. The Invite people screen of the app used to make a
 * code and tell the owner to copy it; now the function makes the code AND sends it, so the owner invites people
 * from the app directly. It follows the order of work of the sign-up function (see ./signup.ts):
 *
 *   1. validate the body            400   (no database access, no throttle slot used)
 *   2. throttle the admin           429   (BEFORE the code table is touched)
 *   3. the super-admin check        403 not_admin
 *      (public.create_invite_code_for refuses a non-admin anyway; the pre-check keeps the admin's own e-mail
 *      gate in the function, so the mail is only ever prepared for the app owner)
 *   4. create the code              500 when the database fails (nothing was created yet)
 *   5. render + send the mail       201 { code, sent: true | false }
 *      a failed send NEVER loses the code: it is returned with sent=false, and the screen falls back to the
 *      copy flow that was there before (the code already exists, so the mail must not orphan it).
 *
 * Nothing secret is ever logged: only outcome kinds. E-mail addresses and codes never reach `log`.
 */
import type { ApiResult } from './http.ts';
import { apiError, rateLimited } from './http.ts';
import { inviteEmail } from './emails.ts';
import type { SendEmail } from './email-send.ts';
import type { ConsumeRateLimit } from './rate-limit.ts';

/** The same limits as the Invite people screen and public.create_invite_code_for (migration 108). */
export const INVITE_USES_LIMITS = { min: 1, max: 1000 } as const;
export const INVITE_VALID_DAYS_LIMITS = { min: 1, max: 3650 } as const;

export const INVITE_RATE_LIMIT_BUCKET = 'send-invite';
/** 20 invites per hour is far beyond what one owner sends; the throttle only catches accidents and abuse. */
export const DEFAULT_INVITE_LIMITS = { perAdmin: 20, windowSeconds: 3600 } as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** RFC 5321 limit for a mailbox address (the same rule as the sign-up function). */
export const MAX_EMAIL_LENGTH = 254;

/** A provided whole number inside `limits`, else null (absent / malformed / out of range). */
function countIn(raw: unknown, limits: { min: number; max: number }): number | null {
  if (raw === undefined || raw === null) return null;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(n) || n < limits.min || n > limits.max) return null;
  return n;
}

export interface InviteDeps {
  consumeRateLimit: ConsumeRateLimit;
  /** The caller's profiles.is_admin, read with the service role (the flag itself is owner-only in the database). */
  isSuperAdmin: (userId: string) => Promise<boolean>;
  /** public.create_invite_code_for, with the service role: makes XXXX-XXXX-XXXX for the lower-cased address. */
  createInviteCodeFor: (email: string, maxUses: number, validDays: number | null) => Promise<string>;
  /** The rendered mail goes out through fullsend; a dry run (local dev) only logs it. */
  sendEmail: SendEmail;
  /** The web app the e-mail links to; unset uses the templates' default (https://ration.safetpojskic.com). */
  appUrl?: string;
  /** Receives outcome kinds only. */
  log?: (message: string, detail?: unknown) => void;
}

export interface ParsedInviteBody {
  /** Trimmed and lower-case. */
  email: string;
  maxUses: number;
  validDays: number | null;
}


/** Validates the body the app sends: { email, maxUses?, validDays? }. */
export function parseInviteBody(body: unknown): ParsedInviteBody | ApiResult {
  const rec = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!rec) {
    return apiError(400, 'invalid_request', 'Body must be { "email": string, "maxUses"?: number, "validDays"?: number | null }.');
  }
  const rawEmail = rec.email;
  if (typeof rawEmail !== 'string') {
    return apiError(400, 'invalid_email', 'Enter the e-mail address of the person you are inviting.');
  }
  const email = rawEmail.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
    return apiError(400, 'invalid_email', 'Enter a valid e-mail address, for example anna@example.com.');
  }
  let maxUses = 1;
  if (rec.maxUses !== undefined) {
    const n = countIn(rec.maxUses, INVITE_USES_LIMITS);
    if (n === null) {
      return apiError(400, 'invalid_max_uses', `Enter a whole number from ${INVITE_USES_LIMITS.min} to ${INVITE_USES_LIMITS.max}.`);
    }
    maxUses = n;
  }
  let validDays: number | null = null;
  if (rec.validDays !== undefined && rec.validDays !== null) {
    const n = countIn(rec.validDays, INVITE_VALID_DAYS_LIMITS);
    if (n === null) {
      return apiError(400, 'invalid_valid_days', `Enter a whole number from ${INVITE_VALID_DAYS_LIMITS.min} to ${INVITE_VALID_DAYS_LIMITS.max}.`);
    }
    validDays = n;
  }
  return { email, maxUses, validDays };
}

/**
 * POST { email, maxUses?, validDays? } for a signed-in super admin. The e-mail address is never logged;
 * `sent: false` on any mail failure, with the code in the answer either way.
 */
export async function sendInvite(userId: string, body: unknown, deps: InviteDeps): Promise<ApiResult> {
  const log = (kind: string, detail?: unknown) => deps.log?.(kind, detail);

  const parsed = parseInviteBody(body);
  if ('status' in parsed) {
    log('invalid_request');
    return parsed;
  }
  const { email, maxUses, validDays } = parsed;

  const wait = await deps.consumeRateLimit(userId, INVITE_RATE_LIMIT_BUCKET, DEFAULT_INVITE_LIMITS.perAdmin, DEFAULT_INVITE_LIMITS.windowSeconds);
  if (wait > 0) {
    log('rate_limited');
    return rateLimited(wait, undefined, 'Too many invites in a short time. Please try again later.');
  }

  if (!(await deps.isSuperAdmin(userId))) {
    log('not_admin');
    return apiError(403, 'not_admin', 'Only the app owner can invite people.');
  }

  let code: string;
  try {
    code = await deps.createInviteCodeFor(email, maxUses, validDays);
  } catch (err) {
    log('create_failed', err instanceof Error ? err.name : 'exception');
    return apiError(500, 'internal_error', 'Something went wrong. Please try again.');
  }

  const mail = inviteEmail({ code, validDays, appUrl: deps.appUrl });
  const outcome = await deps.sendEmail({ ...mail, to: email });
  if (!outcome.ok) {
    log(`send_failed:${outcome.reason}`);
    return { status: 201, body: { code, sent: false } };
  }
  log('sent', outcome.id === null ? undefined : outcome.id);
  return { status: 201, body: { code, sent: true } };
}
