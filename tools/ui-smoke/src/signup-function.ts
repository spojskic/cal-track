/**
 * The Edge Function `sign-up` (supabase/functions/sign-up) as the smoke harness's mock backend answers it.
 *
 * Validation is the REAL one (`parseSignUpRequest` from supabase/functions/_shared/signup.ts), so a form the function would
 * refuse is refused here too. The rest mirrors the order of the real handler: per-client throttle -> consume the invite
 * code -> create the user (a taken e-mail gives the code back). Codes live in memory, per mock backend (= per scenario run).
 * Pure: no sockets, no timers.
 */
import { normalizeInviteCode, parseSignUpRequest } from '../../../supabase/functions/_shared/signup.ts';

/** A single-use code that works once per run. */
export const SIGNUP_VALID_CODE = 'K7M2-9QXA-F3TW';
/** A code that exists but has expired. */
export const SIGNUP_EXPIRED_CODE = 'E3PR-D2KM-7NQ4';
/** A code that exists and has no uses left. */
export const SIGNUP_USED_UP_CODE = 'V9NN-2JKX-HH6R';
/** The real function allows 5 attempts per client per 10 minutes (DEFAULT_SIGNUP_LIMITS). */
export const SIGNUP_ATTEMPTS_PER_CLIENT = 5;

interface InviteSpec {
  maxUses: number;
  expired: boolean;
}

const INVITES: Readonly<Record<string, InviteSpec>> = {
  [normalizeInviteCode(SIGNUP_VALID_CODE)]: { maxUses: 1, expired: false },
  [normalizeInviteCode(SIGNUP_EXPIRED_CODE)]: { maxUses: 1, expired: true },
  [normalizeInviteCode(SIGNUP_USED_UP_CODE)]: { maxUses: 1, expired: false },
};

export interface FunctionAnswer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** What the function needs from the mock backend: the user table. */
export interface SignUpHost {
  emailTaken(email: string): boolean;
  createUser(email: string, password: string): void;
}

const refusal = (status: number, error: string, message: string, extra: Record<string, unknown> = {}): FunctionAnswer => ({
  status,
  body: { error, message, ...extra },
});

export class SignUpFunctionMock {
  private readonly uses = new Map<string, number>([[normalizeInviteCode(SIGNUP_USED_UP_CODE), 1]]);
  private attempts = 0;

  /** Slots used so far of a code (any spelling). */
  usesOf(code: string): number {
    return this.uses.get(normalizeInviteCode(code)) ?? 0;
  }

  handle(method: string, rawBody: string | null, host: SignUpHost): FunctionAnswer {
    if (method !== 'POST') {
      return { ...refusal(405, 'method_not_allowed', 'Use POST with a JSON body.'), headers: { Allow: 'POST, OPTIONS' } };
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody ?? '');
    } catch {
      return refusal(400, 'invalid_json', 'Request body must be valid JSON.');
    }

    const parsed = parseSignUpRequest(body);
    if ('status' in parsed) return { status: parsed.status, body: parsed.body };

    this.attempts += 1;
    if (this.attempts > SIGNUP_ATTEMPTS_PER_CLIENT) {
      return {
        ...refusal(429, 'rate_limited', 'Too many attempts. Please try again later.', { retryAfterSeconds: 600, scope: 'client' }),
        headers: { 'Retry-After': '600' },
      };
    }

    const code = normalizeInviteCode(parsed.inviteCode);
    const spec = INVITES[code];
    if (!spec) return refusal(403, 'invite_invalid', 'That invite code is not valid.');
    if (spec.expired) return refusal(403, 'invite_expired', 'That invite code has expired.');
    const used = this.uses.get(code) ?? 0;
    if (used >= spec.maxUses) return refusal(403, 'invite_used_up', 'That invite code has already been used.');

    this.uses.set(code, used + 1);
    if (host.emailTaken(parsed.email)) {
      this.uses.set(code, used); // released again, like release_invite_code()
      return refusal(409, 'email_taken', 'An account with this e-mail address already exists.');
    }
    host.createUser(parsed.email, parsed.password);
    return { status: 201, body: { ok: true } };
  }
}
