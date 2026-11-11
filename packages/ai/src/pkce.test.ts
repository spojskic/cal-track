import { describe, expect, it } from 'vitest';
import { OpenRouterError } from './errors';
import {
  base64UrlEncode,
  buildAuthUrl,
  challengeFromVerifier,
  createPkcePair,
  createState,
  exchangeAuthCode,
  parseAuthCallback,
  parsePastedCode,
  sha256Js,
} from './pkce';
import { jsonResponse, mockFetch } from './test-helpers';

// RFC 7636 appendix B
const RFC_BYTES = Uint8Array.from([
  116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91,
  88, 5, 88, 83, 132, 141, 121,
]);
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

describe('base64url', () => {
  it('encodes without padding using the URL-safe alphabet', () => {
    expect(base64UrlEncode(new Uint8Array([]))).toBe('');
    expect(base64UrlEncode(new Uint8Array([0xfb]))).toBe('-w');
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe('-__-');
    expect(base64UrlEncode(RFC_BYTES)).toBe(RFC_VERIFIER);
  });

  it('matches btoa-based base64url for varied inputs', () => {
    for (let len = 0; len < 40; len++) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 37 + len * 11) % 256);
      const reference = btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      expect(base64UrlEncode(bytes)).toBe(reference);
    }
  });
});

describe('sha256', () => {
  it('pure JS fallback equals crypto.subtle for many lengths', async () => {
    for (const len of [0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const data = new Uint8Array(len).map((_, i) => (i * 31 + 7) % 256);
      const subtle = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
      expect(hex(sha256Js(data))).toBe(hex(subtle));
    }
  });

  it('knows the empty-string vector', () => {
    expect(hex(sha256Js(new Uint8Array()))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('createPkcePair', () => {
  it('reproduces the RFC 7636 appendix B vector with injected randomness', async () => {
    const pair = await createPkcePair({ randomBytes: () => RFC_BYTES });
    expect(pair).toEqual({ verifier: RFC_VERIFIER, challenge: RFC_CHALLENGE, method: 'S256' });
  });

  it('challengeFromVerifier works with subtle and with the JS fallback', async () => {
    expect(await challengeFromVerifier(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
    expect(await challengeFromVerifier(RFC_VERIFIER, async (d) => sha256Js(d))).toBe(RFC_CHALLENGE);
  });

  it('generates a valid random verifier (43..128 chars, base64url) that differs each time', async () => {
    const a = await createPkcePair();
    const b = await createPkcePair();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.verifier).not.toBe(b.verifier);
    const long = await createPkcePair({ byteLength: 96 });
    expect(long.verifier).toHaveLength(128);
    await expect(createPkcePair({ byteLength: 16 })).rejects.toThrow(RangeError);
    await expect(createPkcePair({ byteLength: 97 })).rejects.toThrow(RangeError);
  });

  it('createState is url-safe', () => {
    expect(createState()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe('buildAuthUrl', () => {
  it('builds the documented URL', () => {
    const url = buildAuthUrl({
      callbackUrl: 'ration://auth/callback?x=1',
      challenge: RFC_CHALLENGE,
      state: 'st ate',
      keyLabel: 'Ration (iPhone)',
    });
    expect(url).toBe(
      'https://openrouter.ai/auth?callback_url=ration%3A%2F%2Fauth%2Fcallback%3Fx%3D1' +
        `&code_challenge=${RFC_CHALLENGE}&code_challenge_method=S256&state=st%20ate&key_label=Ration%20(iPhone)`,
    );
  });

  it('omits callback_url for the headless flow', () => {
    const url = buildAuthUrl({ challenge: RFC_CHALLENGE });
    expect(url).toBe(`https://openrouter.ai/auth?code_challenge=${RFC_CHALLENGE}&code_challenge_method=S256`);
  });
});

describe('parseAuthCallback', () => {
  it('extracts the code and checks state', () => {
    expect(parseAuthCallback('ration://auth/callback?code=abc123&state=xyz', 'xyz')).toEqual({
      ok: true,
      code: 'abc123',
      state: 'xyz',
    });
    expect(parseAuthCallback('https://app.example/cb?code=a%2Bb&state=s#frag', 's')).toMatchObject({ ok: true, code: 'a+b' });
  });

  it('rejects state mismatch, missing state, missing code and denial', () => {
    expect(parseAuthCallback('x://cb?code=abc&state=evil', 'good')).toMatchObject({ ok: false, reason: 'state_mismatch' });
    expect(parseAuthCallback('x://cb?code=abc', 'good')).toMatchObject({ ok: false, reason: 'state_mismatch' });
    expect(parseAuthCallback('x://cb?state=good', 'good')).toMatchObject({ ok: false, reason: 'missing_code' });
    expect(parseAuthCallback('x://cb?error=access_denied&state=good', 'good')).toMatchObject({ ok: false, reason: 'denied' });
    expect(parseAuthCallback('x://cb')).toMatchObject({ ok: false, reason: 'missing_code' });
  });

  it('does not require state when none was expected', () => {
    expect(parseAuthCallback('x://cb?code=abc')).toMatchObject({ ok: true, code: 'abc' });
  });

  it('parsePastedCode accepts a bare code or a pasted URL', () => {
    expect(parsePastedCode('  abc123  ')).toBe('abc123');
    expect(parsePastedCode('https://x.test/?code=zzz&foo=1')).toBe('zzz');
    expect(parsePastedCode('two words')).toBeNull();
    expect(parsePastedCode('')).toBeNull();
  });
});

describe('exchangeAuthCode', () => {
  it('POSTs code + verifier and returns the key', async () => {
    const m = mockFetch(jsonResponse({ key: 'sk-or-v1-newkey1234567890', user_id: 'u' }));
    const key = await exchangeAuthCode({ code: 'CODE', verifier: RFC_VERIFIER, fetch: m.fetch });
    expect(key).toBe('sk-or-v1-newkey1234567890');
    const call = m.calls[0]!;
    expect(call.url).toBe('https://openrouter.ai/api/v1/auth/keys');
    expect(call.method).toBe('POST');
    expect(call.body).toEqual({ code: 'CODE', code_verifier: RFC_VERIFIER, code_challenge_method: 'S256' });
    expect(call.headers.Authorization).toBeUndefined();
  });

  it('maps an expired/invalid code to a friendly bad_request', async () => {
    const m = mockFetch(jsonResponse({ error: { code: 400, message: 'Invalid code_challenge_method' } }, 400));
    await expect(exchangeAuthCode({ code: 'x', verifier: 'y', fetch: m.fetch })).rejects.toMatchObject({
      kind: 'bad_request',
      userMessage: expect.stringMatching(/invalid or has expired/),
    });
  });

  it('fails when no key comes back', async () => {
    const m = mockFetch(jsonResponse({}));
    const err = await exchangeAuthCode({ code: 'x', verifier: 'y', fetch: m.fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(OpenRouterError);
    expect(err.kind).toBe('provider');
  });

  it('maps network errors without leaking the code', async () => {
    const m = mockFetch(new TypeError('failed to fetch CODE-SECRET'));
    const err = await exchangeAuthCode({ code: 'CODE-SECRET', verifier: 'verifier-secret', fetch: m.fetch }).catch((e) => e);
    expect(err.kind).toBe('network');
    expect(err.message).not.toContain('CODE-SECRET');
  });
});
