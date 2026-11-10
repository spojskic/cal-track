import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  basicAuthHeader,
  buildRefreshRequest,
  buildTicketExchangeRequest,
  redeemServiceTicket,
  refreshTokens,
} from './auth';
import { DEFAULT_CLIENT_ID, DI_CLIENT_IDS, DI_GRANT_TYPE, DI_TOKEN_URL, NATIVE_HEADERS, SSO_SERVICE_URL } from './constants';
import { GarminError } from './errors';
import type { GarminTokens } from './tokens';
import { REFRESH_TOKEN, TICKET, accessToken, createFakeFetch, json, parseForm, referenceBase64, reply } from './test-utils';

const TOKENS: GarminTokens = {
  diToken: accessToken(-5),
  diRefreshToken: REFRESH_TOKEN,
  diClientId: DEFAULT_CLIENT_ID,
};

const form = parseForm;

// Nothing in this file may reach the real network.
beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('the real fetch must never be called in tests');
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('request builders', () => {
  it('basicAuthHeader is Basic base64(client_id + ":")', () => {
    expect(basicAuthHeader('abc')).toBe(`Basic ${referenceBase64('abc:')}`);
    expect(basicAuthHeader(DEFAULT_CLIENT_ID)).toBe(`Basic ${referenceBase64(`${DEFAULT_CLIENT_ID}:`)}`);
  });

  it('the refresh request is a POST to the DI token endpoint with the refresh_token grant', () => {
    const req = buildRefreshRequest(TOKENS);
    expect(req.url).toBe(DI_TOKEN_URL);
    expect(req.url).toBe('https://diauth.garmin.com/di-oauth2-service/oauth/token');
    expect(req.init.method).toBe('POST');
    expect(form(req.init.body)).toEqual({
      grant_type: 'refresh_token',
      client_id: DEFAULT_CLIENT_ID,
      refresh_token: REFRESH_TOKEN,
    });
    expect(req.init.headers.Authorization).toBe(basicAuthHeader(DEFAULT_CLIENT_ID));
    expect(req.init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(req.init.headers.Accept).toBe('application/json');
    expect(req.init.headers['Cache-Control']).toBe('no-cache');
  });

  it('carries the native Android app headers', () => {
    const { headers } = buildRefreshRequest(TOKENS).init;
    for (const [k, v] of Object.entries(NATIVE_HEADERS)) expect(headers[k], k).toBe(v);
    expect(headers['User-Agent']).toBe('GCM-Android-5.23');
    expect(headers['X-Garmin-Client-Platform']).toBe('Android');
    expect(headers['X-GCExperience']).toBe('GC5');
  });

  it('refreshes with the client id the token was issued for', () => {
    const req = buildRefreshRequest({ ...TOKENS, diClientId: 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4' });
    expect(req.init.headers.Authorization).toBe(basicAuthHeader('GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4'));
    expect(form(req.init.body).client_id).toBe('GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4');
  });

  it('the ticket exchange uses the custom service_ticket grant and the service URL of the sign-in page', () => {
    const req = buildTicketExchangeRequest(DEFAULT_CLIENT_ID, TICKET);
    expect(req.url).toBe(DI_TOKEN_URL);
    expect(req.init.method).toBe('POST');
    expect(form(req.init.body)).toEqual({
      client_id: DEFAULT_CLIENT_ID,
      service_ticket: TICKET,
      grant_type: DI_GRANT_TYPE,
      service_url: SSO_SERVICE_URL,
    });
    expect(DI_GRANT_TYPE).toBe('https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket');
  });

  it('the client id list is newest first, 2025Q2 at the head', () => {
    expect(DI_CLIENT_IDS[0]).toBe('GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2');
    expect(DI_CLIENT_IDS).toHaveLength(4);
  });
});

describe('refreshTokens', () => {
  const newAccess = accessToken(3600, { client_id: 'FROM_JWT_CLIENT' });

  it('returns the new pair, with the client id read from the new JWT', async () => {
    const { fetch, calls } = createFakeFetch(() => json(200, { access_token: newAccess, refresh_token: 'rotated-refresh' }));
    const fresh = await refreshTokens(fetch, TOKENS);
    expect(fresh).toEqual({ diToken: newAccess, diRefreshToken: 'rotated-refresh', diClientId: 'FROM_JWT_CLIENT' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(DI_TOKEN_URL);
    expect(calls[0]?.init.method).toBe('POST');
  });

  it('keeps the old refresh token and client id when Garmin does not rotate them', async () => {
    const plain = accessToken(3600, { client_id: '' });
    const { fetch } = createFakeFetch(() => json(200, { access_token: plain }));
    const fresh = await refreshTokens(fetch, TOKENS);
    expect(fresh.diRefreshToken).toBe(REFRESH_TOKEN);
    expect(fresh.diClientId).toBe(DEFAULT_CLIENT_ID);
  });

  it('HTTP 400 and 401 mean the session is dead', async () => {
    for (const status of [400, 401]) {
      const { fetch } = createFakeFetch(() => json(status, { error: 'invalid_grant' }));
      const e = await refreshTokens(fetch, TOKENS).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(GarminError);
      expect((e as GarminError).kind).toBe('session_dead');
      expect((e as GarminError).status).toBe(status);
    }
  });

  it('other failures are transient, not "dead"', async () => {
    const kinds: Record<number, string> = { 429: 'rate_limited', 500: 'server', 503: 'server', 403: 'blocked', 404: 'blocked' };
    for (const [status, kind] of Object.entries(kinds)) {
      const { fetch } = createFakeFetch(() => reply(Number(status), 'x', { 'retry-after': '7' }));
      const e = (await refreshTokens(fetch, TOKENS).catch((x: unknown) => x)) as GarminError;
      expect(e.kind, status).toBe(kind);
      if (kind === 'rate_limited') expect(e.retryAfterSeconds).toBe(7);
    }
  });

  it('maps a dropped connection to network, a hung one to timeout, junk to parse', async () => {
    const down = createFakeFetch(() => new Error('socket hang up'));
    expect(((await refreshTokens(down.fetch, TOKENS).catch((x: unknown) => x)) as GarminError).kind).toBe('network');

    const hung = vi.fn(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise<never>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    );
    const timedOut = (await refreshTokens(hung as never, TOKENS, { timeoutMs: 15 }).catch((x: unknown) => x)) as GarminError;
    expect(timedOut.kind).toBe('timeout');

    for (const body of ['not json', '{}', '{"access_token":""}', '[]']) {
      const { fetch } = createFakeFetch(() => reply(200, body));
      expect(((await refreshTokens(fetch, TOKENS).catch((x: unknown) => x)) as GarminError).kind, body).toBe('parse');
    }
  });

  it('never puts a token into an error', async () => {
    const { fetch } = createFakeFetch(() => json(401, { error: `bad ${REFRESH_TOKEN} ${TOKENS.diToken}` }));
    const e = (await refreshTokens(fetch, TOKENS).catch((x: unknown) => x)) as GarminError;
    const text = `${e.message} ${e.userMessage} ${e.detail ?? ''} ${JSON.stringify(e)}`;
    expect(text).not.toContain(REFRESH_TOKEN);
    expect(text).not.toContain(TOKENS.diToken);
  });
});

describe('redeemServiceTicket', () => {
  const ok = (clientId?: string) => json(200, { access_token: accessToken(3600, clientId ? { client_id: clientId } : {}), refresh_token: 'first-refresh' });

  it('returns the first token pair, tagged with the client id the token was issued for', async () => {
    const { fetch, calls } = createFakeFetch(() => ok());
    const tokens = await redeemServiceTicket(fetch, TICKET);
    expect(tokens.diRefreshToken).toBe('first-refresh');
    expect(tokens.diClientId).toBe(DEFAULT_CLIENT_ID);
    expect(calls).toHaveLength(1);
    expect(form(calls[0]?.init.body)).toMatchObject({ service_ticket: TICKET, service_url: SSO_SERVICE_URL, client_id: DI_CLIENT_IDS[0] });
  });

  it('walks the client ids newest first until one accepts', async () => {
    const { fetch, calls } = createFakeFetch((c) =>
      form(c.init.body).client_id === DI_CLIENT_IDS[2] ? ok('GARMIN_CONNECT_MOBILE_ANDROID_DI') : reply(401, 'unauthorized_client'),
    );
    const tokens = await redeemServiceTicket(fetch, TICKET);
    expect(calls.map((c) => form(c.init.body).client_id)).toEqual(DI_CLIENT_IDS.slice(0, 3));
    expect(tokens.diClientId).toBe('GARMIN_CONNECT_MOBILE_ANDROID_DI');
    // each attempt authenticates as the client id it names
    expect(calls[1]?.init.headers.Authorization).toBe(basicAuthHeader(DI_CLIENT_IDS[1] as string));
  });

  it('stops at once when the ticket is spent: it fails the same way for every id', async () => {
    const { fetch, calls } = createFakeFetch(() => reply(400, '{"error":"invalid service ticket"}'));
    const e = (await redeemServiceTicket(fetch, TICKET).catch((x: unknown) => x)) as GarminError;
    expect(e.kind).toBe('ticket_rejected');
    expect(calls).toHaveLength(1);
  });

  it('stops on 429 and on a dropped network without trying the other ids', async () => {
    const limited = createFakeFetch(() => reply(429, '', { 'retry-after': '12' }));
    const e = (await redeemServiceTicket(limited.fetch, TICKET).catch((x: unknown) => x)) as GarminError;
    expect(e.kind).toBe('rate_limited');
    expect(e.retryAfterSeconds).toBe(12);
    expect(limited.calls).toHaveLength(1);

    const down = createFakeFetch(() => new Error('offline'));
    expect(((await redeemServiceTicket(down.fetch, TICKET).catch((x: unknown) => x)) as GarminError).kind).toBe('network');
    expect(down.calls).toHaveLength(1);
  });

  it('fails with exchange_failed when no id is accepted', async () => {
    const { fetch, calls } = createFakeFetch(() => reply(403, 'nope'));
    const e = (await redeemServiceTicket(fetch, TICKET).catch((x: unknown) => x)) as GarminError;
    expect(e.kind).toBe('exchange_failed');
    expect(calls).toHaveLength(DI_CLIENT_IDS.length);
  });

  it('refuses a token response without a refresh token (the session would die within the hour)', async () => {
    const { fetch } = createFakeFetch(() => json(200, { access_token: accessToken(3600) }));
    const e = (await redeemServiceTicket(fetch, TICKET).catch((x: unknown) => x)) as GarminError;
    expect(e.kind).toBe('exchange_failed');
  });

  it('never shows the ticket or a token in an error', async () => {
    const { fetch } = createFakeFetch(() => reply(400, `{"error":"invalid service ticket ${TICKET}"}`));
    const e = (await redeemServiceTicket(fetch, TICKET).catch((x: unknown) => x)) as GarminError;
    expect(`${e.message} ${e.userMessage} ${JSON.stringify(e)}`).not.toContain(TICKET);
  });
});
