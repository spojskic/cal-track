/**
 * Friend requests by e-mail, with the notification mail (pure: all I/O is injected; web-standard APIs only).
 *
 * The pure handler behind the `friend-request` Edge Function. The Friends screen used to call
 * public.send_friend_request directly; now the Edge Function in front of it ALSO mails the addressee, and only
 * when a request was actually created (public.send_friend_request_internal answers created = true for nothing
 * else). An address without an account keeps the exact same client-side answer ('sent'), so the app never
 * learns which addresses have accounts - the only difference is that a real request now also arrives by e-mail.
 *
 * Order of work:
 *   1. validate the body        400   (no database access, no throttle slot used)
 *   2. throttle the sender      429   (BEFORE the friendship table is touched)
 *   3. create the request       400 own_email | 400 invalid_email | 429 too_many (the database's own refusals)
 *   4. mail the addressee       only for status 'sent' AND created; a failed mail is NOT a failed request
 *
 * Nothing secret is ever logged: only outcome kinds. E-mail addresses never reach `log`.
 */
import type { ApiResult } from './http.ts';
import { apiError, rateLimited } from './http.ts';
import { friendRequestEmail } from './emails.ts';
import type { SendEmail } from './email-send.ts';
import type { ConsumeRateLimit } from './rate-limit.ts';

export const FRIEND_REQUEST_RATE_LIMIT_BUCKET = 'friend-request';
/** The same pace as the database's own 20-requests-a-day limit (migration 109). */
export const DEFAULT_FRIEND_REQUEST_LIMITS = { perUser: 20, windowSeconds: 86_400 } as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** RFC 5321 limit for a mailbox address (the same rule as the sign-up function). */
export const MAX_EMAIL_LENGTH = 254;

export interface FriendRequestDeps {
  consumeRateLimit: ConsumeRateLimit;
  /** public.send_friend_request_internal with the service role (the requester comes from the verified JWT). */
  sendRequestInternal: (requesterId: string, email: string) => Promise<SendRequestOutcome>;
  /** The sender's public.display_name, read with the service role (the app never knows other people's names). */
  displayNameOf: (userId: string) => Promise<string>;
  sendEmail: SendEmail;
  /** The web app the e-mail links to; unset uses the templates' default (https://ration.safetpojskic.com). */
  appUrl?: string;
  /** Receives outcome kinds only. */
  log?: (message: string, detail?: unknown) => void;
}

export type SendRequestOutcome =
  /** `status` is sent | accepted | already_friends | already_requested; `created` is true only for a new row. */
  | { kind: 'ok'; status: string; created: boolean }
  /** The database's 22023 refusals, split the way the app words them. */
  | { kind: 'own_email' }
  | { kind: 'invalid_email' }
  /** 54000: more than 20 requests in a day. */
  | { kind: 'too_many' }
  /** Anything else; `reason` is a short machine token, never a message. */
  | { kind: 'error'; reason: string };

export function parseFriendRequestBody(body: unknown): { email: string } | ApiResult {
  const rec = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!rec) {
    return apiError(400, 'invalid_request', 'Body must be { "email": string }.');
  }
  const rawEmail = rec.email;
  if (typeof rawEmail !== 'string') {
    return apiError(400, 'invalid_email', "Enter your friend's e-mail address.");
  }
  const email = rawEmail.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
    return apiError(400, 'invalid_email', 'Enter a valid e-mail address, for example anna@example.com.');
  }
  return { email };
}

/** POST { email } for a signed-in user. The answer mirrors send_friend_request: status is sent | accepted | already_friends | already_requested. */
export async function friendRequest(userId: string, body: unknown, deps: FriendRequestDeps): Promise<ApiResult> {
  const log = (kind: string, detail?: unknown) => deps.log?.(kind, detail);

  const parsed = parseFriendRequestBody(body);
  if ('status' in parsed) {
    log('invalid_request');
    return parsed;
  }
  const { email } = parsed;

  const wait = await deps.consumeRateLimit(userId, FRIEND_REQUEST_RATE_LIMIT_BUCKET, DEFAULT_FRIEND_REQUEST_LIMITS.perUser, DEFAULT_FRIEND_REQUEST_LIMITS.windowSeconds);
  if (wait > 0) {
    log('rate_limited');
    return rateLimited(wait, undefined, 'You have sent a lot of requests today. Try again tomorrow.');
  }

  const outcome = await deps.sendRequestInternal(userId, email);
  if (outcome.kind !== 'ok') {
    switch (outcome.kind) {
      case 'own_email':
        log('own_email');
        return apiError(400, 'own_email', 'That is your own e-mail address.');
      case 'invalid_email':
        log('invalid_email');
        return apiError(400, 'invalid_email', 'Enter a valid e-mail address, for example anna@example.com.');
      case 'too_many':
        log('too_many');
        return rateLimited(DEFAULT_FRIEND_REQUEST_LIMITS.windowSeconds, undefined, 'You have sent a lot of requests today. Try again tomorrow.');
      default:
        log(`request_failed:${outcome.reason}`);
        return apiError(500, 'internal_error', 'Something went wrong. Please try again.');
    }
  }

  if (outcome.status === 'sent' && outcome.created) {
    let displayName = '';
    try {
      displayName = await deps.displayNameOf(userId);
    } catch {
      log('name_lookup_failed'); // the template falls back to "Somebody"
    }
    const mail = friendRequestEmail({ displayName, appUrl: deps.appUrl });
    const sent = await deps.sendEmail({ ...mail, to: email });
    if (!sent.ok) log(`mail_failed:${sent.reason}`);
  }

  log(outcome.status === 'sent' ? (outcome.created ? 'sent_with_mail' : 'sent_without_mail') : outcome.status);
  return { status: 200, body: { status: outcome.status } };
}
