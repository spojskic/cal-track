import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  APP_RETURN_PATH,
  DEFAULT_APP_REDIRECT,
  DEFAULT_AUTHORIZE_URL,
  DEFAULT_DEREGISTER_URL,
  DEFAULT_TOKEN_URL,
  DEFAULT_USER_ID_URL,
  base64Url,
  buildAppRedirect,
  buildAuthorizeUrl,
  buildTokenRequest,
  canExchangeToken,
  canStartOAuth,
  codeChallengeS256,
  constantTimeEqual,
  createPkce,
  generateCodeVerifier,
  generateState,
  parseGarminUserId,
  parseTokenResponse,
  presentedWebhookSecret,
  readGarminConfig,
  sanitizeReason,
  webhookAuthorized,
  type GarminConfig,
} from '../../../supabase/functions/_shared/garmin-oauth.ts';
import {
  readRequestText,
  redirectResponse,
  textResponse,
} from '../../../supabase/functions/_shared/garmin-http.ts';
import { gzipSync } from 'node:zlib';

const env = (values: Record<string, string>) => (name: string) => values[name];

const cfg = (extra: Record<string, string> = {}): GarminConfig =>
  readGarminConfig(
    env({
      SUPABASE_URL: 'https://abc.supabase.co/',
      GARMIN_CLIENT_ID: 'client-id',
      GARMIN_CLIENT_SECRET: 'client-secret',
      GARMIN_WEBHOOK_SECRET: 'w'.repeat(32),
      ...extra,
    }),
  );

describe('garmin-oauth: configuration', () => {
  it('has documented defaults and derives the redirect URI from SUPABASE_URL', () => {
    const c = cfg();
    expect(c.authorizeUrl).toBe(DEFAULT_AUTHORIZE_URL);
    expect(c.authorizeUrl).toBe('https://apis.garmin.com/tools/oauth2/authorizeUser');
    expect(c.tokenUrl).toBe(DEFAULT_TOKEN_URL);
    expect(c.userIdUrl).toBe(DEFAULT_USER_ID_URL);
    expect(c.deregisterUrl).toBe(DEFAULT_DEREGISTER_URL);
    expect(c.redirectUri).toBe('https://abc.supabase.co/functions/v1/garmin-oauth-callback');
    expect(c.appRedirectNative).toBe(DEFAULT_APP_REDIRECT);
    expect(c.appRedirectNative).toBe('caltrack://settings/integrations');
    expect(c.tokenAuthStyle).toBe('body');
    expect(c.scopes).toBeUndefined();
    expect(c.appUrl).toBeUndefined();
    expect(c.deleteDataOnDeregister).toBe(true);
  });

  it('every endpoint and the redirect can be overridden with secrets', () => {
    const c = cfg({
      GARMIN_AUTHORIZE_URL: 'https://a.example/authorize',
      GARMIN_TOKEN_URL: 'https://a.example/token',
      GARMIN_USER_ID_URL: 'https://a.example/id',
      GARMIN_DEREGISTER_URL: 'https://a.example/dereg',
      GARMIN_REDIRECT_URI: 'https://custom.example/cb',
      GARMIN_SCOPES: 'WELLNESS ACTIVITY',
      GARMIN_TOKEN_AUTH_STYLE: 'BASIC',
      GARMIN_APP_REDIRECT: 'myapp://done',
      APP_URL: 'https://app.example.com/',
      GARMIN_DELETE_DATA_ON_DEREGISTER: 'false',
    });
    expect(c).toMatchObject({
      authorizeUrl: 'https://a.example/authorize',
      tokenUrl: 'https://a.example/token',
      userIdUrl: 'https://a.example/id',
      deregisterUrl: 'https://a.example/dereg',
      redirectUri: 'https://custom.example/cb',
      scopes: 'WELLNESS ACTIVITY',
      tokenAuthStyle: 'basic',
      appRedirectNative: 'myapp://done',
      appUrl: 'https://app.example.com',
      deleteDataOnDeregister: false,
    });
  });

  it('is not configured without a client id (start) / client secret (exchange)', () => {
    expect(canStartOAuth(readGarminConfig(env({ SUPABASE_URL: 'https://abc.supabase.co' })))).toBe(
      false,
    );
    expect(
      canStartOAuth(
        readGarminConfig(env({ GARMIN_CLIENT_ID: '  ', SUPABASE_URL: 'https://abc.supabase.co' })),
      ),
    ).toBe(false);
    expect(canStartOAuth(cfg())).toBe(true);
    expect(
      canExchangeToken(
        readGarminConfig(env({ GARMIN_CLIENT_ID: 'x', SUPABASE_URL: 'https://abc.supabase.co' })),
      ),
    ).toBe(false);
    expect(canExchangeToken(cfg())).toBe(true);
  });
});

describe('garmin-oauth: PKCE', () => {
  it('computes the S256 challenge of the RFC 7636 appendix B test vector', async () => {
    expect(await codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('base64url has no padding or URL-unsafe characters', () => {
    expect(base64Url(new Uint8Array([251, 255, 254]))).toBe('-__-');
    expect(base64Url(new Uint8Array([1]))).toBe('AQ');
  });

  it('verifier and state are long, URL-safe, random and different on every call', () => {
    const v = generateCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(v.length).toBe(64);
    const s = generateState();
    expect(s).toMatch(/^[A-Za-z0-9_-]{16,200}$/);
    expect(generateCodeVerifier()).not.toBe(v);
    expect(generateState()).not.toBe(s);
  });

  it('createPkce: challenge = BASE64URL(SHA256(verifier)) and uses the injected random source', async () => {
    let n = 0;
    const counting = (len: number) => Uint8Array.from({ length: len }, () => n++ % 256);
    const p = await createPkce(counting);
    const expected = createHash('sha256').update(p.verifier).digest('base64url');
    expect(p.challenge).toBe(expected);
    expect(p.verifier).toHaveLength(64);
    expect(p.state).toHaveLength(32);
  });

  it('builds the authorize URL with PKCE parameters (and scope only when configured)', () => {
    const url = new URL(buildAuthorizeUrl(cfg(), { state: 'st', challenge: 'ch' }));
    expect(url.origin + url.pathname).toBe('https://apis.garmin.com/tools/oauth2/authorizeUser');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'client-id',
      redirect_uri: 'https://abc.supabase.co/functions/v1/garmin-oauth-callback',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
      state: 'st',
    });
    const scoped = new URL(
      buildAuthorizeUrl(cfg({ GARMIN_SCOPES: 'a b' }), { state: 's', challenge: 'c' }),
    );
    expect(scoped.searchParams.get('scope')).toBe('a b');
    expect(buildAuthorizeUrl(cfg(), { state: 'st', challenge: 'ch' })).not.toContain(
      'client-secret',
    );
  });
});

describe('garmin-oauth: token endpoint', () => {
  it('builds the authorization-code exchange with client credentials in the body by default', () => {
    const r = buildTokenRequest(cfg(), {
      grant: 'authorization_code',
      code: 'the-code',
      codeVerifier: 'the-verifier',
    });
    expect(r.url).toBe(DEFAULT_TOKEN_URL);
    expect(r.init.method).toBe('POST');
    expect((r.init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(Object.fromEntries(new URLSearchParams(r.init.body as string))).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      code_verifier: 'the-verifier',
      redirect_uri: 'https://abc.supabase.co/functions/v1/garmin-oauth-callback',
      client_id: 'client-id',
      client_secret: 'client-secret',
    });
  });

  it('can send the client credentials as HTTP Basic instead (GARMIN_TOKEN_AUTH_STYLE=basic)', () => {
    const r = buildTokenRequest(cfg({ GARMIN_TOKEN_AUTH_STYLE: 'basic' }), {
      grant: 'refresh_token',
      refreshToken: 'rt',
    });
    const headers = r.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`,
    );
    const body = Object.fromEntries(new URLSearchParams(r.init.body as string));
    expect(body).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rt',
      client_id: 'client-id',
    });
  });

  it('parses a standard token response and tolerates missing optional fields', () => {
    const now = Date.UTC(2026, 10, 10, 12);
    expect(
      parseTokenResponse(
        {
          access_token: ' at ',
          refresh_token: 'rt',
          expires_in: 86400,
          refresh_token_expires_in: '7776000',
          scope: 'WELLNESS ACTIVITY',
        },
        now,
      ),
    ).toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: new Date(now + 86_400_000).toISOString(),
      refreshExpiresAt: new Date(now + 7_776_000_000).toISOString(),
      scopes: ['WELLNESS', 'ACTIVITY'],
    });
    expect(parseTokenResponse({ access_token: 'only' }, now)).toEqual({
      accessToken: 'only',
      refreshToken: null,
      expiresAt: null,
      refreshExpiresAt: null,
      scopes: [],
    });
  });

  it('rejects unusable responses', () => {
    for (const bad of [
      null,
      'x',
      [],
      {},
      { access_token: '' },
      { access_token: 5 },
      { refresh_token: 'r' },
    ]) {
      expect(parseTokenResponse(bad)).toBeNull();
    }
  });

  it('parses the Garmin user id from the usual shapes', () => {
    expect(parseGarminUserId({ userId: 'abc-123' })).toBe('abc-123');
    expect(parseGarminUserId({ userId: 4711 })).toBe('4711');
    expect(parseGarminUserId({ id: 'x' })).toBe('x');
    expect(parseGarminUserId('plain-id')).toBe('plain-id');
    for (const bad of [null, {}, [], '', { userId: '' }, { userId: {} }])
      expect(parseGarminUserId(bad)).toBeNull();
  });
});

describe('garmin-oauth: return to the app', () => {
  it('native -> the deep link (default scheme caltrack) with garmin=connected / error&reason', () => {
    expect(buildAppRedirect(cfg(), 'native', { ok: true })).toBe(
      'caltrack://settings/integrations?garmin=connected',
    );
    expect(buildAppRedirect(cfg(), 'native', { ok: false, reason: 'access_denied' })).toBe(
      'caltrack://settings/integrations?garmin=error&reason=access_denied',
    );
  });

  it('web -> APP_URL + /settings/integrations; null when APP_URL is not configured', () => {
    expect(
      buildAppRedirect(cfg({ APP_URL: 'https://app.example.com/' }), 'web', { ok: true }),
    ).toBe(`https://app.example.com${APP_RETURN_PATH}?garmin=connected`);
    expect(buildAppRedirect(cfg(), 'web', { ok: true })).toBeNull();
  });

  it('appends to a base that already has a query, and never takes the target from the request', () => {
    expect(
      buildAppRedirect(cfg({ GARMIN_APP_REDIRECT: 'caltrack://x?a=1' }), 'native', { ok: true }),
    ).toBe('caltrack://x?a=1&garmin=connected');
  });

  it('sanitises the reason so it cannot inject URL parts', () => {
    expect(sanitizeReason('Token Exchange Failed!')).toBe('token_exchange_failed');
    expect(sanitizeReason('a&garmin=connected#x')).toBe('a_garmin_connected_x');
    expect(sanitizeReason('???')).toBe('unknown');
    expect(sanitizeReason('x'.repeat(100))).toHaveLength(40);
    expect(
      buildAppRedirect(cfg(), 'native', { ok: false, reason: 'evil&redirect=https://x' }),
    ).toBe('caltrack://settings/integrations?garmin=error&reason=evil_redirect_https_x');
  });
});

describe('garmin-oauth: webhook secret', () => {
  const req = (
    url = 'https://x.supabase.co/functions/v1/garmin-webhook',
    headers: Record<string, string> = {},
  ) => new Request(url, { method: 'POST', headers });

  it('constantTimeEqual compares by value, also for different lengths and unicode', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('', 'a')).toBe(false);
    expect(constantTimeEqual('čšž', 'čšž')).toBe(true);
    expect(constantTimeEqual('čšž', 'csz')).toBe(false);
  });

  it('reads the secret from a header, a Bearer token or ?secret= (in that order)', () => {
    expect(presentedWebhookSecret(req(undefined, { 'x-garmin-webhook-secret': 'h' }))).toBe('h');
    expect(presentedWebhookSecret(req(undefined, { 'x-webhook-secret': 'h2' }))).toBe('h2');
    expect(presentedWebhookSecret(req(undefined, { authorization: 'Bearer b' }))).toBe('b');
    expect(presentedWebhookSecret(req('https://x/f?secret=q'))).toBe('q');
    expect(
      presentedWebhookSecret(
        req('https://x/f?secret=q', { authorization: 'Bearer b', 'x-garmin-webhook-secret': 'h' }),
      ),
    ).toBe('h');
    expect(presentedWebhookSecret(req())).toBeNull();
    expect(presentedWebhookSecret(req(undefined, { authorization: 'Basic abc' }))).toBeNull();
  });

  it('authorises only the exact configured secret, and never when none is configured', () => {
    const secret = 'S'.repeat(24);
    expect(webhookAuthorized(req(undefined, { 'x-garmin-webhook-secret': secret }), secret)).toBe(
      true,
    );
    expect(webhookAuthorized(req(`https://x/f?secret=${secret}`), secret)).toBe(true);
    expect(
      webhookAuthorized(req(undefined, { 'x-garmin-webhook-secret': secret + 'x' }), secret),
    ).toBe(false);
    expect(webhookAuthorized(req(), secret)).toBe(false);
    expect(webhookAuthorized(req(undefined, { 'x-garmin-webhook-secret': '' }), '')).toBe(false);
    expect(
      webhookAuthorized(req(undefined, { 'x-garmin-webhook-secret': 'anything' }), undefined),
    ).toBe(false);
  });
});

describe('garmin-http', () => {
  const post = (body: string | Uint8Array, headers: Record<string, string> = {}) =>
    new Request('https://x/f', { method: 'POST', body, headers, duplex: 'half' } as RequestInit);

  it('reads a plain body and enforces the byte limit', async () => {
    expect(await readRequestText(post('{"a":1}'))).toEqual({ ok: true, text: '{"a":1}' });
    expect(await readRequestText(post('x'.repeat(100)), 50)).toEqual({
      ok: false,
      status: 413,
      error: 'payload_too_large',
    });
    expect(await readRequestText(new Request('https://x/f', { method: 'POST' }))).toEqual({
      ok: true,
      text: '',
    });
  });

  it('inflates a gzip body and caps the INFLATED size', async () => {
    const payload = JSON.stringify({ dailies: [{ userId: 'u' }] });
    const zipped = gzipSync(payload);
    expect(await readRequestText(post(zipped, { 'content-encoding': 'gzip' }))).toEqual({
      ok: true,
      text: payload,
    });
    const bomb = gzipSync('a'.repeat(100_000));
    expect(bomb.byteLength).toBeLessThan(1000);
    expect(await readRequestText(post(bomb, { 'content-encoding': 'gzip' }), 10_000)).toEqual({
      ok: false,
      status: 413,
      error: 'payload_too_large',
    });
    expect((await readRequestText(post('not gzip', { 'content-encoding': 'gzip' }))).ok).toBe(
      false,
    );
  });

  it('redirectResponse is a no-store 302; textResponse is plain text', () => {
    const r = redirectResponse('caltrack://settings/integrations?garmin=connected');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('caltrack://settings/integrations?garmin=connected');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const t = textResponse(400, 'nope');
    expect([t.status, t.headers.get('content-type')]).toEqual([400, 'text/plain; charset=utf-8']);
  });
});
