/**
 * Supabase adapters for the `sign-up` Edge Function: thin wrappers over the service-role-only invite-code RPCs of
 * migration 20261110000100_invite_codes.sql and over `auth.admin.createUser`. Only the tiny surfaces below are needed,
 * so unit tests pass fakes (or a PGlite-backed object) and `sign-up/index.ts` passes the real service-role client.
 */
import { StoreError, type SupabaseLike } from './food-store.ts';
import { asRecord } from './http.ts';
import type { CreateUserOutcome, InviteOutcome } from './signup.ts';

/** What of `supabase.auth.admin` the function uses (the real client satisfies it structurally). */
export interface AdminAuthLike {
  admin: {
    createUser(attributes: {
      email: string;
      password: string;
      email_confirm: boolean;
    }): PromiseLike<{
      data: unknown;
      error: { message?: string; code?: string; status?: number; name?: string } | null;
    }>;
  };
}

export type SignUpAdminClient = SupabaseLike & { auth: AdminAuthLike };

const INVITE_OUTCOMES: readonly string[] = ['ok', 'invalid', 'expired', 'used_up', 'revoked'];

export interface InviteStore {
  consume(code: string): Promise<InviteOutcome>;
  release(code: string): Promise<void>;
}

export function makeInviteStore(admin: SupabaseLike): InviteStore {
  return {
    async consume(code) {
      const res = await admin.rpc('consume_invite_code', { p_code: code });
      if (res.error) throw new StoreError('consume_invite_code', res.error);
      if (typeof res.data !== 'string' || !INVITE_OUTCOMES.includes(res.data)) {
        throw new StoreError('consume_invite_code', { message: 'unexpected response' });
      }
      return res.data as InviteOutcome;
    },
    async release(code) {
      const res = await admin.rpc('release_invite_code', { p_code: code });
      if (res.error) throw new StoreError('release_invite_code', res.error);
    },
  };
}

const EMAIL_TAKEN_CODES = new Set([
  'email_exists',
  'user_already_exists',
  'identity_already_exists',
]);

/**
 * GoTrue error -> outcome. Current GoTrue answers 422 with `code: "email_exists"`; older versions only had the message
 * "A user with this email address has already been registered", so both are recognised. The `reason` of an unknown
 * error is a sanitised code or `status_<n>` (never the message, which could contain the address).
 */
export function classifyCreateUserError(error: {
  message?: string;
  code?: string;
  status?: number;
}): CreateUserOutcome {
  const code = typeof error.code === 'string' ? error.code : '';
  if (EMAIL_TAKEN_CODES.has(code)) return { kind: 'email_taken' };
  if (/already (?:been )?registered|already exists|already in use/i.test(error.message ?? '')) {
    return { kind: 'email_taken' };
  }
  if (code === 'weak_password') return { kind: 'invalid_password' };
  if (code === 'email_address_invalid') return { kind: 'invalid_email' };
  const safeCode = /^[a-z0-9_]{1,60}$/.test(code) ? code : '';
  const status =
    typeof error.status === 'number' && error.status > 0 ? `status_${error.status}` : '';
  return { kind: 'error', reason: safeCode || status || 'unknown' };
}

export function makeCreateUser(client: {
  auth: AdminAuthLike;
}): (email: string, password: string) => Promise<CreateUserOutcome> {
  return async (email, password) => {
    const res = await client.auth.admin.createUser({ email, password, email_confirm: true });
    if (res.error) return classifyCreateUserError(res.error);
    const user = asRecord(asRecord(res.data)?.user);
    if (!user || typeof user.id !== 'string') return { kind: 'error', reason: 'no_user' };
    return { kind: 'created' };
  };
}
