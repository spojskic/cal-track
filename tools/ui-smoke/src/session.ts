/**
 * Auth helpers: deterministic UUIDs, unsigned JWTs and the GoTrue session JSON that supabase-js keeps in
 * localStorage (`sb-mock-auth-token`).
 *
 * GoTrueClient (auth-js 2.119) only requires `access_token`, `refresh_token` and `expires_at` for a stored
 * session to be accepted (`_isValidSession`); `user` must be present as well, otherwise it calls
 * `/auth/v1/user` (`_recoverAndRefresh`). With `expires_at` further than EXPIRY_MARGIN_MS (90 s) away,
 * `getSession()` returns the stored session without any network round trip.
 */
import { createHash } from 'node:crypto';

import { BACKEND_ORIGIN } from './constants';

export interface MockUser {
  id: string;
  email: string;
  password: string;
  createdAt: string;
}

/** Valid-looking v4 UUID derived from a key: the same key always yields the same id. */
export function stableUuid(key: string): string {
  const h = createHash('sha1').update(key).digest('hex');
  const variant = ['8', '9', 'a', 'b'][Number.parseInt(h.charAt(16), 16) % 4] as string;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const b64url = (input: string): string => Buffer.from(input, 'utf8').toString('base64url');

/** Unsigned JWT (the mock never verifies signatures; supabase-js never decodes `access_token`). */
export function makeJwt(claims: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}.${b64url('mock-signature')}`;
}

export function decodeJwt(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** GoTrue `User` JSON. */
export function authUserJson(user: MockUser, nowMs: number): Record<string, unknown> {
  const now = new Date(nowMs).toISOString();
  return {
    id: user.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: user.email,
    email_confirmed_at: user.createdAt,
    phone: '',
    confirmed_at: user.createdAt,
    last_sign_in_at: now,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    created_at: user.createdAt,
    updated_at: now,
    is_anonymous: false,
  };
}

export interface MockSession {
  access_token: string;
  token_type: 'bearer';
  expires_in: number;
  expires_at: number;
  refresh_token: string;
  user: Record<string, unknown>;
}

export function buildSession(user: MockUser, opts: { nowMs: number; ttlSeconds: number; refreshToken?: string }): MockSession {
  const iat = Math.floor(opts.nowMs / 1000);
  const exp = iat + opts.ttlSeconds;
  return {
    access_token: makeJwt({
      aud: 'authenticated',
      exp,
      iat,
      iss: `${BACKEND_ORIGIN}/auth/v1`,
      sub: user.id,
      email: user.email,
      phone: '',
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {},
      role: 'authenticated',
      aal: 'aal1',
      amr: [{ method: 'password', timestamp: iat }],
      session_id: stableUuid(`session:${user.id}`),
      is_anonymous: false,
    }),
    token_type: 'bearer',
    expires_in: opts.ttlSeconds,
    expires_at: exp,
    refresh_token: opts.refreshToken ?? `mock-refresh-${user.id.slice(0, 8)}`,
    user: authUserJson(user, opts.nowMs),
  };
}

/** 10 years: the pre-seeded browser session never needs a refresh during a run. */
export const SEED_SESSION_TTL_SECONDS = 10 * 365 * 24 * 3600;
