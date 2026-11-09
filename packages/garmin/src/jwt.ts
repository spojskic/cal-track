// Minimal JWT payload reader. Pure base64url + UTF-8 decoding: no atob, Buffer or TextDecoder (Hermes-safe).
// The signature is NOT verified (we only read `exp` to know when to fetch a new token).

import { GarminError } from './errors';

export type JwtErrorReason = 'shape' | 'base64' | 'json' | 'no_exp';

/** Thrown for a token that cannot be decoded. Never contains the token. */
export class GarminJwtError extends GarminError {
  readonly reason: JwtErrorReason;
  constructor(reason: JwtErrorReason) {
    super({
      kind: 'unexpected',
      message: `Garmin token could not be decoded (${reason})`,
      userMessage: 'Garmin returned an access token this app cannot read. Try again later.',
    });
    this.name = 'GarminJwtError';
    this.reason = reason;
    Object.setPrototypeOf(this, GarminJwtError.prototype);
  }
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOOKUP: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i++) map[ALPHABET.charAt(i)] = i;
  // Tolerate standard base64 characters too.
  map['+'] = 62;
  map['/'] = 63;
  return map;
})();

/** Decodes base64url (padding optional) to bytes. Returns null on invalid characters or impossible length. */
export function base64UrlToBytes(input: string): number[] | null {
  let s = input;
  while (s.endsWith('=')) s = s.slice(0, -1);
  if (s.length % 4 === 1) return null;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const v = LOOKUP[s.charAt(i)];
    if (v === undefined) return null;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  return bytes;
}

/** UTF-8 bytes -> string. Invalid sequences become U+FFFD. */
export function utf8BytesToString(bytes: readonly number[]): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i++] as number;
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
    } else if (b0 >= 0xc2 && b0 < 0xe0 && i < bytes.length) {
      out += String.fromCharCode(((b0 & 0x1f) << 6) | ((bytes[i++] as number) & 0x3f));
    } else if (b0 >= 0xe0 && b0 < 0xf0 && i + 1 < bytes.length) {
      out += String.fromCharCode(
        ((b0 & 0x0f) << 12) | (((bytes[i++] as number) & 0x3f) << 6) | ((bytes[i++] as number) & 0x3f),
      );
    } else if (b0 >= 0xf0 && b0 < 0xf5 && i + 2 < bytes.length) {
      const cp =
        ((b0 & 0x07) << 18) |
        (((bytes[i++] as number) & 0x3f) << 12) |
        (((bytes[i++] as number) & 0x3f) << 6) |
        ((bytes[i++] as number) & 0x3f);
      out += String.fromCodePoint(cp > 0x10ffff ? 0xfffd : cp);
    } else {
      out += '\ufffd';
    }
  }
  return out;
}

/** Decodes base64url to a UTF-8 string, or null when invalid. */
export function base64UrlDecodeToString(input: string): string | null {
  const bytes = base64UrlToBytes(input);
  return bytes ? utf8BytesToString(bytes) : null;
}

/** Reads the JWT payload object. Throws GarminJwtError. */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  if (typeof token !== 'string') throw new GarminJwtError('shape');
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts.some((p, i) => i < 2 && p === '')) throw new GarminJwtError('shape');
  const json = base64UrlDecodeToString(parts[1] as string);
  if (json === null) throw new GarminJwtError('base64');
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    throw new GarminJwtError('json');
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new GarminJwtError('json');
  return payload as Record<string, unknown>;
}

/** The `exp` claim in seconds since the epoch. Throws GarminJwtError on a bad shape or missing/invalid `exp`. */
export function decodeJwtExp(token: string): number {
  const payload = decodeJwtPayload(token);
  const raw = payload.exp;
  const exp = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(exp) || exp <= 0) throw new GarminJwtError('no_exp');
  return exp;
}
