/**
 * OAuth PKCE helpers for "Connect OpenRouter" (user obtains their own API key).
 *
 * Flow:
 *   1. createPkcePair()                      -> { verifier, challenge }
 *   2. buildAuthUrl({ callbackUrl, challenge, state }) -> open in a browser
 *   3. parseAuthCallback(redirectUrl, state) -> { ok: true, code }
 *   4. exchangeAuthCode({ code, verifier })  -> API key (store it in SecureStore / encrypted storage)
 *
 * Codes expire after 10 minutes. The headless variant omits `callbackUrl`;
 * the user copies the code shown on screen and you pass it to
 * `parsePastedCode` and then `exchangeAuthCode` (no `state` is returned in that mode).
 *
 * OpenRouter documents `callback_url` as a public URL or a localhost URL. Custom app
 * schemes (e.g. `ration://`) are not documented as supported: on native prefer the
 * headless/paste flow, or an https page you control that forwards the code to the app.
 */

import { OpenRouterError, errorFromResponse, redactSecrets } from './errors';
import type { FetchLike } from './openrouter';
import { OPENROUTER_BASE_URL } from './openrouter';

export const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';

// ---------------------------------------------------------------------------
// base64url (no Buffer / btoa dependency)
// ---------------------------------------------------------------------------

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** RFC 4648 section 5 base64url, without padding. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out +=
      B64URL_ALPHABET[(n >> 18) & 63]! +
      B64URL_ALPHABET[(n >> 12) & 63]! +
      B64URL_ALPHABET[(n >> 6) & 63]! +
      B64URL_ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] as number) << 16;
    out += B64URL_ALPHABET[(n >> 18) & 63]! + B64URL_ALPHABET[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out += B64URL_ALPHABET[(n >> 18) & 63]! + B64URL_ALPHABET[(n >> 12) & 63]! + B64URL_ALPHABET[(n >> 6) & 63]!;
  }
  return out;
}

// ---------------------------------------------------------------------------
// SHA-256: crypto.subtle when present, pure-JS fallback (Hermes has no subtle)
// ---------------------------------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

/** Pure JS SHA-256 (FIPS 180-4). Only used when `crypto.subtle` is unavailable. */
export function sha256Js(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLen = data.length * 8;
  const paddedLen = (((data.length + 9 + 63) >> 6) << 6) >>> 0;
  const buf = new Uint8Array(paddedLen);
  buf.set(data);
  buf[data.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15] as number;
      const w2 = w[i - 2] as number;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }
    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let hh = h[7] as number;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = ((h[0] as number) + a) >>> 0;
    h[1] = ((h[1] as number) + b) >>> 0;
    h[2] = ((h[2] as number) + c) >>> 0;
    h[3] = ((h[3] as number) + d) >>> 0;
    h[4] = ((h[4] as number) + e) >>> 0;
    h[5] = ((h[5] as number) + f) >>> 0;
    h[6] = ((h[6] as number) + g) >>> 0;
    h[7] = ((h[7] as number) + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i] as number, false);
  return out;
}

export type Sha256Fn = (data: Uint8Array) => Promise<Uint8Array>;

export const defaultSha256: Sha256Fn = async (data) => {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (subtle && typeof subtle.digest === 'function') {
    // Copy into a fresh ArrayBuffer-backed view to satisfy BufferSource typing.
    const copy = new Uint8Array(data.length);
    copy.set(data);
    return new Uint8Array(await subtle.digest('SHA-256', copy));
  }
  return sha256Js(data);
};

export type RandomBytesFn = (length: number) => Uint8Array;

export const defaultRandomBytes: RandomBytesFn = (length) => {
  const c = (globalThis as { crypto?: { getRandomValues?: <T extends ArrayBufferView>(a: T) => T } }).crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new OpenRouterError({
      kind: 'bad_request',
      message: 'crypto.getRandomValues is not available',
      userMessage:
        'Secure random numbers are not available on this device, so OpenRouter sign-in cannot start. Paste an API key manually instead.',
    });
  }
  const bytes = new Uint8Array(length);
  c.getRandomValues(bytes);
  return bytes;
};

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

export interface CreatePkceOptions {
  /** Number of random bytes (32..96 => 43..128 verifier chars). Default 32. */
  byteLength?: number;
  /** Injectable for tests / platforms with a different CSPRNG (e.g. expo-crypto). */
  randomBytes?: RandomBytesFn;
  /** Injectable for platforms without crypto.subtle (a pure-JS fallback is built in). */
  sha256?: Sha256Fn;
}

export async function challengeFromVerifier(verifier: string, sha256: Sha256Fn = defaultSha256): Promise<string> {
  const digest = await sha256(new TextEncoder().encode(verifier));
  return base64UrlEncode(digest);
}

export async function createPkcePair(options: CreatePkceOptions = {}): Promise<PkcePair> {
  const byteLength = options.byteLength ?? 32;
  if (!Number.isInteger(byteLength) || byteLength < 32 || byteLength > 96) {
    throw new RangeError('byteLength must be an integer between 32 and 96 (43..128 verifier characters)');
  }
  const bytes = (options.randomBytes ?? defaultRandomBytes)(byteLength);
  const verifier = base64UrlEncode(bytes);
  const challenge = await challengeFromVerifier(verifier, options.sha256);
  return { verifier, challenge, method: 'S256' };
}

/** Cryptographically random `state` value for CSRF protection. */
export function createState(randomBytes: RandomBytesFn = defaultRandomBytes): string {
  return base64UrlEncode(randomBytes(16));
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

export interface BuildAuthUrlOptions {
  /** Omit for the headless flow (the user pastes the code shown on screen). */
  callbackUrl?: string;
  challenge: string;
  state?: string;
  /** Name the key gets in the OpenRouter dashboard (e.g. "Ration on iPhone"). */
  keyLabel?: string;
  authUrl?: string;
}

export function buildAuthUrl(opts: BuildAuthUrlOptions): string {
  const params: Array<[string, string]> = [];
  if (opts.callbackUrl) params.push(['callback_url', opts.callbackUrl]);
  params.push(['code_challenge', opts.challenge]);
  params.push(['code_challenge_method', 'S256']);
  if (opts.state) params.push(['state', opts.state]);
  if (opts.keyLabel) params.push(['key_label', opts.keyLabel]);
  const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `${opts.authUrl ?? OPENROUTER_AUTH_URL}?${query}`;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

/** Parses `a=1&b=2` (no URL class: unreliable on some React Native versions). */
function parseQuery(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = safeDecode(eq === -1 ? pair : pair.slice(0, eq));
    const value = eq === -1 ? '' : safeDecode(pair.slice(eq + 1));
    if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = value;
  }
  return out;
}

export type AuthCallbackResult =
  | { ok: true; code: string; state?: string }
  | { ok: false; reason: 'denied' | 'missing_code' | 'state_mismatch'; message: string };

/**
 * Extracts `code` from the redirect URL. When `expectedState` is given the
 * callback must echo the same `state`.
 */
export function parseAuthCallback(url: string, expectedState?: string): AuthCallbackResult {
  const hashIdx = url.indexOf('#');
  const noHash = hashIdx === -1 ? url : url.slice(0, hashIdx);
  const qIdx = noHash.indexOf('?');
  const params: Record<string, string> = qIdx === -1 ? {} : parseQuery(noHash.slice(qIdx + 1));

  if (params.error) {
    return {
      ok: false,
      reason: 'denied',
      message: 'OpenRouter sign-in was cancelled or denied.',
    };
  }
  if (expectedState !== undefined && params.state !== expectedState) {
    return {
      ok: false,
      reason: 'state_mismatch',
      message: 'The sign-in response did not match this request. Please start again.',
    };
  }
  const code = params.code?.trim();
  if (!code) {
    return { ok: false, reason: 'missing_code', message: 'No sign-in code was returned. Please try again.' };
  }
  return { ok: true, code, state: params.state };
}

/** Headless flow: accepts either the bare code or a pasted URL containing `code=`. */
export function parsePastedCode(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/[?&]code=/.test(trimmed)) {
    const r = parseAuthCallback(trimmed);
    return r.ok ? r.code : null;
  }
  return /^\S+$/.test(trimmed) ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Code exchange
// ---------------------------------------------------------------------------

export interface ExchangeAuthCodeOptions {
  code: string;
  verifier: string;
  fetch?: FetchLike;
  baseUrl?: string;
  signal?: AbortSignal;
}

/** Exchanges the one-time code for the user's API key. The caller must store the key securely. */
export async function exchangeAuthCode(opts: ExchangeAuthCodeOptions): Promise<string> {
  const f = opts.fetch ?? (globalThis as { fetch?: FetchLike }).fetch?.bind(globalThis);
  if (!f) throw new OpenRouterError({ kind: 'network', message: 'fetch is not available in this runtime' });
  const url = `${(opts.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, '')}/auth/keys`;

  let response: Response;
  try {
    response = await f(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        code: opts.code,
        code_verifier: opts.verifier,
        code_challenge_method: 'S256',
      }),
      signal: opts.signal,
    });
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    throw new OpenRouterError({
      kind: 'network',
      message: `Network error: ${redactSecrets(e instanceof Error ? e.message : String(e), opts.code, opts.verifier)}`,
    });
  }

  let text = '';
  try {
    text = await response.text();
  } catch {
    text = '';
  }
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }

  if (!response.ok) {
    const err = errorFromResponse({ status: response.status, body: json ?? text });
    if (response.status === 400 || response.status === 403 || response.status === 404 || response.status === 409) {
      throw new OpenRouterError({
        kind: 'bad_request',
        status: response.status,
        message: err.message,
        userMessage: 'The sign-in code is invalid or has expired (codes last 10 minutes). Please connect OpenRouter again.',
        retryable: false,
      });
    }
    throw err;
  }

  const key = (json as { key?: unknown } | undefined)?.key;
  if (typeof key !== 'string' || key.length < 8) {
    throw new OpenRouterError({
      kind: 'provider',
      status: response.status,
      message: 'OpenRouter did not return a key',
    });
  }
  return key;
}
