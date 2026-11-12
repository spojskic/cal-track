/**
 * The Edge Function `send-invite` (supabase/functions/send-invite) as the smoke harness's mock backend answers it.
 *
 * Validation is the REAL one (`parseInviteBody` from supabase/functions/_shared/invite.ts) and the mail is the
 * REAL render (`inviteEmail`), recorded on the instance instead of sent. The code creation and the admin check
 * are the mock backend's own state through a `SendInviteHost` (the same helpers the admin_create_invite_code_for
 * RPC uses), so a failed request rolls back with everything else. Pure: no sockets, no timers, no clock.
 */
import { inviteEmail } from '../../../supabase/functions/_shared/emails.ts';
import { parseInviteBody } from '../../../supabase/functions/_shared/invite.ts';
import { DEFAULT_INVITE_LIMITS } from '../../../supabase/functions/_shared/invite.ts';

/** What the function needs from the mock backend: the admin state and the code creation. */
export interface SendInviteHost {
  isAdmin(): boolean;
  /** public.create_invite_code_for with the service role: returns the FORMATTED code or throws InviteAdminError. */
  createInviteFor(email: string, maxUses: number, validDays: number | null): string;
}

export interface FunctionAnswer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** A rendered e-mail that was not sent (the smoke harness has no Resend). */
export interface SentInviteMail {
  to: string;
  subject: string;
  code: string;
}

const refusal = (status: number, error: string, message: string, extra: Record<string, unknown> = {}): FunctionAnswer => ({
  status,
  body: { error, message, ...extra },
});

export class SendInviteFunctionMock {
  private attempts = 0;
  readonly mails: SentInviteMail[] = [];

  handle(method: string, rawBody: string | null, host: SendInviteHost): FunctionAnswer {
    if (method !== 'POST') {
      return { ...refusal(405, 'method_not_allowed', 'Use POST with a JSON body.'), headers: { Allow: 'POST, OPTIONS' } };
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody ?? '');
    } catch {
      return refusal(400, 'invalid_json', 'Request body must be valid JSON.');
    }

    const parsed = parseInviteBody(body);
    if ('status' in parsed) return { status: parsed.status, body: parsed.body };
    const { email, maxUses, validDays } = parsed;

    // The same order as the real function: throttle BEFORE the code table is touched.
    this.attempts += 1;
    if (this.attempts > DEFAULT_INVITE_LIMITS.perAdmin) {
      return {
        ...refusal(429, 'rate_limited', 'Too many invites in a short time. Please try again later.', {
          retryAfterSeconds: DEFAULT_INVITE_LIMITS.windowSeconds,
        }),
        headers: { 'Retry-After': String(DEFAULT_INVITE_LIMITS.windowSeconds) },
      };
    }

    if (!host.isAdmin()) return refusal(403, 'not_admin', 'Only the app owner can invite people.');

    let code: string;
    try {
      code = host.createInviteFor(email, maxUses, validDays);
    } catch {
      // the real handler catches a database failure the same way: 500, and nothing was created yet
      return refusal(500, 'internal_error', 'Something went wrong. Please try again.');
    }
    const mail = inviteEmail({ code, validDays });
    this.mails.push({ to: email, subject: mail.subject, code });
    return { status: 201, body: { code, sent: true } };
  }
}
