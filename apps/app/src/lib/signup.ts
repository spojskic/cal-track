/**
 * Rules and messages of the "Create account" form (invite-code sign-up). Pure TypeScript with NO React Native / Expo /
 * `@/` imports on purpose, so the logic is unit-tested in tools/db-tests (app-signup.test.ts). The Edge Function
 * `sign-up` (supabase/functions/_shared/signup.ts) enforces the same limits; keep both in sync.
 */

export const MIN_PASSWORD_LENGTH = 8;
/** bcrypt, which Supabase Auth uses, only handles 72 BYTES. */
export const MAX_PASSWORD_BYTES = 72;
export const MAX_EMAIL_LENGTH = 254;
/** Codes made by `public.create_invite_code()` have 12 characters; shorter input is certainly incomplete. */
export const MIN_INVITE_CODE_LENGTH = 8;
/** Typed codes are capped here so that the grouped text (with dashes) stays below the server limit of 32 characters. */
export const MAX_INVITE_CODE_LENGTH = 24;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ---------------------------------------------------------------------------
// Invite code text
// ---------------------------------------------------------------------------

/** 'k7m2 9qxa-f3tw' -> 'K7M29QXAF3TW': letters and digits only, upper-case. */
export function normalizeInviteCode(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/**
 * What the invite code field shows for whatever was typed or pasted: normalised, capped and grouped in fours
 * (`K7M2-9QXA-F3TW`). A dash only appears once a character follows it, so typing and deleting feel natural.
 */
export function formatInviteCodeInput(raw: string): string {
  const code = normalizeInviteCode(raw).slice(0, MAX_INVITE_CODE_LENGTH);
  return code.replace(/(.{4})(?=.)/g, '$1-');
}

// ---------------------------------------------------------------------------
// Form validation (mirrors the server)
// ---------------------------------------------------------------------------

export interface SignUpInput {
  email: string;
  password: string;
  confirmPassword: string;
  inviteCode: string;
}

export type SignUpField = 'email' | 'password' | 'confirmPassword' | 'inviteCode';
export type SignUpFieldErrors = Partial<Record<SignUpField, string>>;

/** UTF-8 length without TextEncoder (not available in every React Native runtime). */
export function utf8Length(value: string): number {
  let bytes = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export function isPlausibleEmail(email: string): boolean {
  const trimmed = email.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_EMAIL_LENGTH && EMAIL_RE.test(trimmed);
}

/** Field errors of the form; an empty object means "send it". */
export function validateSignUp(input: SignUpInput): SignUpFieldErrors {
  const errors: SignUpFieldErrors = {};
  if (input.email.trim() === '') errors.email = 'Enter your e-mail address.';
  else if (!isPlausibleEmail(input.email)) errors.email = 'Enter a valid e-mail address.';

  if (input.password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  } else if (utf8Length(input.password) > MAX_PASSWORD_BYTES) {
    errors.password = `Use at most ${MAX_PASSWORD_BYTES} characters.`;
  }

  if (input.confirmPassword === '') errors.confirmPassword = 'Repeat the password.';
  else if (input.confirmPassword !== input.password) errors.confirmPassword = 'The passwords do not match.';

  if (normalizeInviteCode(input.inviteCode).length < MIN_INVITE_CODE_LENGTH) {
    errors.inviteCode = 'Enter the full invite code from your invitation.';
  }
  return errors;
}

export const hasErrors = (errors: SignUpFieldErrors): boolean => Object.keys(errors).length > 0;

/** Field errors of the "set a new password" form (the reset-password screen); an empty object means "send it". */
export function validateNewPassword(
  password: string,
  confirmPassword: string,
): Pick<SignUpFieldErrors, 'password' | 'confirmPassword'> {
  const errors: Pick<SignUpFieldErrors, 'password' | 'confirmPassword'> = {};
  if (password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  } else if (utf8Length(password) > MAX_PASSWORD_BYTES) {
    errors.password = `Use at most ${MAX_PASSWORD_BYTES} characters.`;
  }

  if (confirmPassword === '') errors.confirmPassword = 'Repeat the password.';
  else if (confirmPassword !== password) errors.confirmPassword = 'The passwords do not match.';
  return errors;
}

// ---------------------------------------------------------------------------
// Server answers -> friendly text
// ---------------------------------------------------------------------------

export interface SignUpFailureInput {
  /** HTTP status of the answer; null = the request never got one (offline, blocked, DNS ...). */
  status: number | null;
  /** The `error` code of the JSON body (`invite_expired`, `email_taken`, ...). */
  code: string | null;
  retryAfterSeconds: number | null;
}

export interface SignUpFailure {
  message: string;
  /** The field the message belongs to, when there is one. */
  field?: SignUpField;
}

export function retryText(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return 'in a few minutes';
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

export const NOT_AVAILABLE_MESSAGE = 'Sign-up is not available right now. Ask the app owner.';
export const OFFLINE_MESSAGE = 'Could not reach the server. Check your connection and try again.';
export const GENERIC_FAILURE_MESSAGE = 'Could not create the account. Try again in a moment.';

export function describeSignUpFailure(f: SignUpFailureInput): SignUpFailure {
  switch (f.code) {
    case 'invite_invalid':
    case 'invite_revoked':
    case 'invalid_invite_code':
      return { message: 'That invite code is not valid.', field: 'inviteCode' };
    case 'invite_expired':
      return { message: 'That code has expired.', field: 'inviteCode' };
    case 'invite_used_up':
      return { message: 'That code has already been used.', field: 'inviteCode' };
    case 'email_taken':
      return { message: 'An account with this e-mail already exists. Try signing in.', field: 'email' };
    case 'invalid_email':
      return { message: 'Enter a valid e-mail address.', field: 'email' };
    case 'invalid_password':
      return {
        message: `Use ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_BYTES} characters for the password.`,
        field: 'password',
      };
    case 'rate_limited':
      return { message: `Too many attempts. Try again ${retryText(f.retryAfterSeconds)}.` };
    default:
      break;
  }
  if (f.status === 429) return { message: `Too many attempts. Try again ${retryText(f.retryAfterSeconds)}.` };
  if (f.status === null) return { message: OFFLINE_MESSAGE };
  // The Supabase gateway answers 404 for a function that is not deployed (no `error` code of ours in the body).
  if (f.status === 404) return { message: NOT_AVAILABLE_MESSAGE };
  return { message: GENERIC_FAILURE_MESSAGE };
}
