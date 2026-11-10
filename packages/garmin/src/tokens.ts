// Token pair helpers: JWT expiry, the early-refresh rule, (de)serialisation. Pure: no storage, no clock of its own.

import { EXPIRY_SKEW_SEC } from './constants';
import { decodeJwtPayload } from './jwt';

/**
 * The DI OAuth2 token pair. The client id is stored with the tokens: refreshing must use the id the token was issued for.
 * NEVER log this object, never send it anywhere but Garmin, never put it in Supabase.
 */
export interface GarminTokens {
  /** Short-lived access token (a JWT). Sent as `Authorization: Bearer`. */
  diToken: string;
  /** Refresh token. Garmin may rotate it on every refresh: always persist the new one. */
  diRefreshToken: string;
  diClientId: string;
}

function claims(token: string): Record<string, unknown> | null {
  try {
    return decodeJwtPayload(token);
  } catch {
    return null;
  }
}

/** The `client_id` claim of an access token, when it has one. */
export function clientIdFromJwt(token: string): string | null {
  const c = claims(token);
  return c && typeof c.client_id === 'string' && c.client_id !== '' ? c.client_id : null;
}

/**
 * Seconds until the access token expires (JWT `exp`), or null when the token is not a readable JWT. Unreadable is
 * treated as "refresh now", never as "assume valid".
 */
export function tokenExpiresInSec(tokens: Pick<GarminTokens, 'diToken'>, nowMs: number): number | null {
  const c = claims(tokens.diToken);
  if (!c) return null;
  const raw = c.exp;
  const exp = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(exp) || exp <= 0) return null;
  return exp - nowMs / 1000;
}

/** True when the access token has `skewSec` (default 120) or less left, or cannot be read. */
export function isTokenExpired(
  tokens: Pick<GarminTokens, 'diToken'>,
  nowMs: number,
  skewSec: number = EXPIRY_SKEW_SEC,
): boolean {
  const left = tokenExpiresInSec(tokens, nowMs);
  return left === null || left <= skewSec;
}

export function isGarminTokens(value: unknown): value is GarminTokens {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.diToken === 'string' &&
    v.diToken !== '' &&
    typeof v.diRefreshToken === 'string' &&
    v.diRefreshToken !== '' &&
    typeof v.diClientId === 'string' &&
    v.diClientId !== ''
  );
}
