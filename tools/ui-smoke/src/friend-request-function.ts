/**
 * The Edge Function `friend-request` (supabase/functions/friend-request) as the smoke harness's mock backend answers it.
 *
 * Validation is the REAL one (`parseFriendRequestBody` from supabase/functions/_shared/friend-request.ts) and the mail
 * is the REAL render (`friendRequestEmail`), recorded on the instance instead of sent. The request itself is created
 * through a `FriendRequestHost` (the mock backend's own friends state, the same helpers the send_friend_request RPC
 * uses); `created` decides whether the mail goes out, exactly like public.send_friend_request_internal answers it.
 * Pure: no sockets, no timers, no clock.
 */
import { friendRequestEmail } from '../../../supabase/functions/_shared/emails.ts';
import { parseFriendRequestBody } from '../../../supabase/functions/_shared/friend-request.ts';
import { DEFAULT_FRIEND_REQUEST_LIMITS, type SendRequestOutcome } from '../../../supabase/functions/_shared/friend-request.ts';

/** What the function needs from the mock backend: the caller, the request creation and the sender's name. */
export interface FriendRequestHost {
  /** auth.uid() of the verified JWT. */
  uid: string;
  /** public.send_friend_request_internal with the service role (the same outcome union the real store maps to). */
  send(requesterId: string, email: string): { status: string; created: boolean } | SendRequestOutcome;
  /** The sender's public.display_name (may fail: the template has a name fallback). */
  displayNameOf(requesterId: string): string;
  /** Set by tests to model an unreachable Resend: the request still succeeds, no mail is recorded. */
  failMail?: boolean;
}

export interface FunctionAnswer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface SentRequestMail {
  to: string;
  subject: string;
}

const refusal = (status: number, error: string, message: string, extra: Record<string, unknown> = {}): FunctionAnswer => ({
  status,
  body: { error, message, ...extra },
});

export class FriendRequestFunctionMock {
  private readonly attempts = new Map<string, number>();
  readonly mails: SentRequestMail[] = [];

  handle(method: string, rawBody: string | null, host: FriendRequestHost): FunctionAnswer {
    if (method !== 'POST') {
      return { ...refusal(405, 'method_not_allowed', 'Use POST with a JSON body.'), headers: { Allow: 'POST, OPTIONS' } };
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody ?? '');
    } catch {
      return refusal(400, 'invalid_json', 'Request body must be valid JSON.');
    }

    const parsed = parseFriendRequestBody(body);
    if ('status' in parsed) return { status: parsed.status, body: parsed.body };
    const { email } = parsed;

    // The same order as the real function: throttle BEFORE the friendship table is touched.
    const attempts = (this.attempts.get(host.uid) ?? 0) + 1;
    this.attempts.set(host.uid, attempts);
    if (attempts > DEFAULT_FRIEND_REQUEST_LIMITS.perUser) {
      return {
        ...refusal(429, 'rate_limited', 'You have sent a lot of requests today. Try again tomorrow.', {
          retryAfterSeconds: DEFAULT_FRIEND_REQUEST_LIMITS.windowSeconds,
        }),
        headers: { 'Retry-After': String(DEFAULT_FRIEND_REQUEST_LIMITS.windowSeconds) },
      };
    }

    const outcome = host.send(host.uid, email);
    if ('kind' in outcome && outcome.kind !== 'ok') {
      switch (outcome.kind) {
        case 'own_email':
          return refusal(400, 'own_email', 'That is your own e-mail address.');
        case 'invalid_email':
          return refusal(400, 'invalid_email', 'Enter a valid e-mail address, for example anna@example.com.');
        case 'too_many':
          return refusal(429, 'rate_limited', 'You have sent a lot of requests today. Try again tomorrow.', {
            retryAfterSeconds: DEFAULT_FRIEND_REQUEST_LIMITS.windowSeconds,
          });
        default:
          return refusal(500, 'internal_error', 'Something went wrong. Please try again.');
      }
    }
    const { status, created } = outcome as { status: string; created: boolean };

    if (status === 'sent' && created && !host.failMail) {
      const mail = friendRequestEmail({ displayName: host.displayNameOf(host.uid) });
      this.mails.push({ to: email, subject: mail.subject });
    }
    return { status: 200, body: { status } };
  }
}
