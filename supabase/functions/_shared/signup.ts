/**
 * Invite-code sign-up (pure: all I/O is injected; web-standard APIs only, no Deno globals).
 *
 * Why an Edge Function: public sign-up stays DISABLED in the Supabase auth settings. The account is created with the
 * admin API (service role) after an invite code was consumed, so the owner changes no dashboard setting and no
 * confirmation e-mail is needed. See supabase/migrations/20261110000100_invite_codes.sql for the code table and RPCs.
 *
 * Order of work (each step only runs when the previous one passed):
 *   1. validate the body            400   (no database access, no throttle slot used)
 *   2. throttle per client, then globally   429   (BEFORE the code table is touched: this is what makes guessing codes infeasible)
 *   3. consume the invite code      403   invite_invalid | invite_expired | invite_used_up | invite_revoked
 *   4. create the user              201 | 409 email_taken | 400 invalid_email / invalid_password | 500 internal_error
 *      (any failure here gives the code back with release_invite_code)
 *
 * Nothing secret is ever logged: only outcome kinds. Passwords, codes, e-mail addresses and IP addresses never reach `log`.
 */
import { apiError, asRecord, rateLimited, type ApiResult } from './http.ts';
import { GLOBAL_RATE_LIMIT_USER, type ConsumeRateLimit } from './rate-limit.ts';

export const MIN_PASSWORD_LENGTH = 8;
/** bcrypt (GoTrue) ignores / rejects anything beyond 72 BYTES. */
export const MAX_PASSWORD_BYTES = 72;
/** RFC 5321 limit for a mailbox address. */
export const MAX_EMAIL_LENGTH = 254;
/** Longest raw invite code accepted (a code is 12 characters; 32 leaves room for dashes and spaces). */
export const MAX_INVITE_INPUT_LENGTH = 32;

export const SIGNUP_CLIENT_BUCKET = 'sign-up-client';
export const SIGNUP_GLOBAL_BUCKET = 'sign-up-global';

export interface SignUpLimits {
  /** Attempts per client (hashed IP) per window. */
  perClient: number;
  /** Attempts over all clients per window. */
  global: number;
  windowSeconds: number;
}

/** 5 attempts per client and 20 over everybody per 10 minutes. */
export const DEFAULT_SIGNUP_LIMITS: SignUpLimits = { perClient: 5, global: 20, windowSeconds: 600 };

export type InviteOutcome = 'ok' | 'invalid' | 'expired' | 'used_up' | 'revoked';

export type CreateUserOutcome =
  | { kind: 'created' }
  | { kind: 'email_taken' }
  | { kind: 'invalid_email' }
  | { kind: 'invalid_password' }
  /** `reason` is a short machine token (an error code or `status_<n>`), never a message that could hold personal data. */
  | { kind: 'error'; reason: string };

export interface SignUpDeps {
  consumeRateLimit: ConsumeRateLimit;
  /** public.consume_invite_code: the code is normalised by the database. */
  consumeInvite: (code: string) => Promise<InviteOutcome>;
  /** public.release_invite_code */
  releaseInvite: (code: string) => Promise<void>;
  /** auth.admin.createUser with a pre-confirmed e-mail. Never throws for an expected failure. */
  createUser: (email: string, password: string) => Promise<CreateUserOutcome>;
  /** Opaque per-client key (a UUID derived from a keyed hash of the IP, see {@link clientKeyFromRequest}). */
  clientKey: string;
  limits?: SignUpLimits;
  /** Receives outcome kinds only. */
  log?: (message: string, detail?: unknown) => void;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Upper-case letters and digits only (the same rule as private.normalize_invite_code in SQL). */
export function normalizeInviteCode(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

export interface ParsedSignUp {
  email: string;
  password: string;
  /** Trimmed, otherwise as typed (dashes, spaces and case are handled by the database). */
  inviteCode: string;
}

export function parseSignUpRequest(body: unknown): ParsedSignUp | ApiResult {
  const rec = asRecord(body);
  if (!rec) {
    return apiError(
      400,
      'invalid_request',
      'Body must be { "email": string, "password": string, "inviteCode": string }.',
    );
  }

  const rawEmail = rec.email;
  if (typeof rawEmail !== 'string') {
    return apiError(400, 'invalid_email', 'Enter a valid e-mail address.');
  }
  const email = rawEmail.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
    return apiError(400, 'invalid_email', 'Enter a valid e-mail address.');
  }

  const password = rec.password;
  if (
    typeof password !== 'string' ||
    password.length < MIN_PASSWORD_LENGTH ||
    utf8Length(password) > MAX_PASSWORD_BYTES
  ) {
    return apiError(
      400,
      'invalid_password',
      `The password must have ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_BYTES} characters.`,
    );
  }

  const rawCode = rec.inviteCode;
  if (typeof rawCode !== 'string') {
    return apiError(400, 'invalid_invite_code', 'Enter the invite code you received.');
  }
  const inviteCode = rawCode.trim();
  if (
    inviteCode.length === 0 ||
    inviteCode.length > MAX_INVITE_INPUT_LENGTH ||
    normalizeInviteCode(inviteCode).length === 0
  ) {
    return apiError(400, 'invalid_invite_code', 'Enter the invite code you received.');
  }

  return { email, password, inviteCode };
}

// ---------------------------------------------------------------------------
// Client key (hashed IP)
// ---------------------------------------------------------------------------

/**
 * The address the request came from. `cf-connecting-ip` is set by the Cloudflare layer in front of Supabase and cannot be
 * chosen by the caller; `x-forwarded-for` (first entry) is the fallback. null when neither header is present.
 */
export function clientAddress(headers: Headers): string | null {
  const cf = headers.get('cf-connecting-ip')?.trim();
  if (cf) return cf;
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || null;
}

/**
 * Canonical throttle key for an address: IPv4 as is (port stripped), IPv6 reduced to its /64 network (one customer
 * usually owns a whole /64, so rotating within it must not mint fresh quotas), anything unparsable as its own key.
 */
export function addressBucket(raw: string | null): string {
  if (!raw) return 'unknown';
  let ip = raw.trim().toLowerCase().slice(0, 100);
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed) ip = bracketed[1]!;
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) ip = mapped[1]!;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return ip;
  if (!ip.includes(':')) return `other:${ip}`;

  const halves = ip.split('::');
  if (halves.length > 2) return `other:${ip}`;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array<string>(Math.max(missing, 0)).fill('0'), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return `other:${ip}`;
  return `v6:${groups
    .slice(0, 4)
    .map((g) => g.padStart(4, '0'))
    .join(':')}`;
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * UUID derived with HMAC-SHA-256 from the caller's address. consume_rate_limit() keys its counters by uuid, and the raw
 * address must not be stored: IPv4 has only 2^32 values, so a PLAIN hash could be reversed from the table in seconds.
 * The key (the function's service-role key, which the runtime injects anyway) makes the stored value useless without it.
 */
export async function clientKeyFromRequest(req: Request, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(
        `${SIGNUP_CLIENT_BUCKET}:${addressBucket(clientAddress(req.headers))}`,
      ),
    ),
  );
  const bytes = mac.slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4 layout, so any uuid parser accepts it
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const INVITE_REFUSALS: Record<Exclude<InviteOutcome, 'ok'>, { error: string; message: string }> = {
  invalid: { error: 'invite_invalid', message: 'That invite code is not valid.' },
  revoked: { error: 'invite_revoked', message: 'That invite code is no longer valid.' },
  expired: { error: 'invite_expired', message: 'That invite code has expired.' },
  used_up: { error: 'invite_used_up', message: 'That invite code has already been used.' },
};

/** POST { email, password, inviteCode } handler. */
export async function signUp(body: unknown, deps: SignUpDeps): Promise<ApiResult> {
  const log = (kind: string) => deps.log?.('outcome', kind);

  const parsed = parseSignUpRequest(body);
  if ('status' in parsed) {
    log('invalid_request');
    return parsed;
  }
  const { email, password, inviteCode } = parsed;

  // Throttle before the code table is touched. The client's own budget comes first so that one abusive client cannot
  // burn the shared budget (a refused client attempt is not counted globally).
  const limits = deps.limits ?? DEFAULT_SIGNUP_LIMITS;
  const clientWait = await deps.consumeRateLimit(
    deps.clientKey,
    SIGNUP_CLIENT_BUCKET,
    limits.perClient,
    limits.windowSeconds,
  );
  if (clientWait > 0) {
    log('rate_limited_client');
    return rateLimited(
      clientWait,
      { scope: 'client' },
      'Too many attempts. Please try again later.',
    );
  }
  const globalWait = await deps.consumeRateLimit(
    GLOBAL_RATE_LIMIT_USER,
    SIGNUP_GLOBAL_BUCKET,
    limits.global,
    limits.windowSeconds,
  );
  if (globalWait > 0) {
    log('rate_limited_global');
    return rateLimited(globalWait, { scope: 'global' }, 'Sign-up is busy. Please try again later.');
  }

  const invite = await deps.consumeInvite(inviteCode);
  if (invite !== 'ok') {
    const refusal = INVITE_REFUSALS[invite];
    log(refusal.error);
    return apiError(403, refusal.error, refusal.message);
  }

  // From here on the code is spent: every way out except "created" must give it back.
  let created: CreateUserOutcome;
  try {
    created = await deps.createUser(email, password);
  } catch (err) {
    created = { kind: 'error', reason: err instanceof Error && err.name ? err.name : 'exception' };
  }
  if (created.kind === 'created') {
    log('created');
    return { status: 201, body: { ok: true } };
  }

  try {
    await deps.releaseInvite(inviteCode);
  } catch {
    log('release_failed');
  }

  switch (created.kind) {
    case 'email_taken':
      log('email_taken');
      return apiError(409, 'email_taken', 'An account with this e-mail address already exists.');
    case 'invalid_email':
      log('invalid_email');
      return apiError(400, 'invalid_email', 'Enter a valid e-mail address.');
    case 'invalid_password':
      log('invalid_password');
      return apiError(
        400,
        'invalid_password',
        `The password must have ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_BYTES} characters.`,
      );
    default:
      log(`create_failed:${created.reason}`);
      return apiError(500, 'internal_error', 'Something went wrong. Please try again.');
  }
}
