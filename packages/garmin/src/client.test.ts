import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GarminConnectClient, assertReadOnly, backoffMs, type GarminConnectClientOptions } from './client';
import { CONNECT_API_BASE, DEFAULT_CLIENT_ID, DI_TOKEN_URL, NATIVE_HEADERS } from './constants';
import { GarminError, isFatalForRun, isNoData } from './errors';
import type { GarminTokens } from './tokens';
import {
  REFRESH_TOKEN,
  accessToken,
  createClock,
  createFakeFetch,
  json,
  reply,
  type FakeCall,
  type FakeReply,
} from './test-utils';

const VALID = accessToken(3600);
const TOKENS: GarminTokens = { diToken: VALID, diRefreshToken: REFRESH_TOKEN, diClientId: DEFAULT_CLIENT_ID };
const FRESH = accessToken(7200, { jti: 'fresh' });

// Nothing in this file may reach the real network.
beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('the real fetch must never be called in tests');
  });
});
afterEach(() => vi.unstubAllGlobals());

/** Every request that is not the token endpoint must be a GET to the Connect API host. */
function expectReadOnly(calls: readonly FakeCall[]): void {
  for (const c of calls) {
    if (c.url === DI_TOKEN_URL) {
      expect(c.init.method).toBe('POST');
    } else {
      expect(c.init.method, c.url).toBe('GET');
      expect(c.url.startsWith(`${CONNECT_API_BASE}/`), c.url).toBe(true);
      expect(c.init.body, c.url).toBeUndefined();
    }
  }
}

function setup(handler: (call: FakeCall) => FakeReply | Promise<FakeReply>, options: Partial<GarminConnectClientOptions> = {}) {
  const clock = createClock();
  const fake = createFakeFetch(handler);
  const client = new GarminConnectClient({
    fetch: fake.fetch,
    tokens: TOKENS,
    now: clock.now,
    sleep: clock.sleep,
    ...options,
  });
  return { client, clock, ...fake };
}

describe('requests', () => {
  it('are GETs to connectapi.garmin.com with the Bearer token and the native app headers', async () => {
    const { client, calls } = setup(() => json(200, { displayName: 'abc' }));
    const r = await client.profile();
    expect(r).toEqual({ status: 200, empty: false, data: { displayName: 'abc' } });
    const c = calls[0] as FakeCall;
    expect(c.url).toBe('https://connectapi.garmin.com/userprofile-service/socialProfile');
    expect(c.init.method).toBe('GET');
    expect(c.init.headers.Authorization).toBe(`Bearer ${VALID}`);
    expect(c.init.headers.Accept).toBe('application/json');
    for (const [k, v] of Object.entries(NATIVE_HEADERS)) expect(c.init.headers[k], k).toBe(v);
  });

  it('use the reference endpoint paths and query strings', async () => {
    const { client, calls } = setup(() => json(200, {}));
    await client.userSummary('name/with slash', '2026-11-09');
    await client.sleep('d-1', '2026-11-09');
    await client.hrv('2026-11-09');
    await client.weightRange('2026-10-27', '2026-11-09');
    await client.activities(50, 50);
    expect(calls.map((c) => c.url.slice(CONNECT_API_BASE.length))).toEqual([
      '/usersummary-service/usersummary/daily/name%2Fwith%20slash?calendarDate=2026-11-09',
      '/wellness-service/wellness/dailySleepData/d-1?date=2026-11-09&nonSleepBufferMinutes=60',
      '/hrv-service/hrv/2026-11-09',
      '/weight-service/weight/dateRange?startDate=2026-10-27&endDate=2026-11-09',
      '/activitylist-service/activities/search/activities?start=50&limit=50',
    ]);
  });

  it('never issue a non-GET to a data endpoint, whatever happens (401, retries, refresh, errors)', async () => {
    let n = 0;
    const { client, calls } = setup((c) => {
      n += 1;
      if (c.url === DI_TOKEN_URL) return json(200, { access_token: FRESH, refresh_token: 'r2' });
      if (n === 2) return reply(401);
      if (n === 5) return reply(503);
      if (n === 7) return reply(429, '', { 'retry-after': '1' });
      if (n === 9) return new Error('offline');
      return json(200, {});
    });
    for (const call of [
      () => client.profile(),
      () => client.userSummary('d', '2026-11-09'),
      () => client.sleep('d', '2026-11-09'),
      () => client.hrv('2026-11-09'),
      () => client.weightRange('2026-11-01', '2026-11-09'),
      () => client.activities(0, 50),
    ]) {
      await call().catch(() => undefined);
    }
    expect(calls.length).toBeGreaterThan(8);
    expect(calls.some((c) => c.url === DI_TOKEN_URL)).toBe(true);
    expectReadOnly(calls);
  });

  it('refuse anything that is not a plain GET to the Connect API host', () => {
    expect(() => assertReadOnly('GET', `${CONNECT_API_BASE}/x`)).not.toThrow();
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
      expect(() => assertReadOnly(method, `${CONNECT_API_BASE}/x`), method).toThrow(GarminError);
    }
    expect(() => assertReadOnly('GET', 'https://evil.test/x')).toThrow(GarminError);
    expect(() => assertReadOnly('GET', 'http://connectapi.garmin.com/x')).toThrow(GarminError);
    expect(() => assertReadOnly('GET', `${DI_TOKEN_URL}`)).toThrow(GarminError);
  });

  it('only build URLs on the Connect API host', async () => {
    const { client, calls } = setup(() => json(200, {}));
    await client.userSummary('..//evil.test/', '2026-11-09');
    expect(calls[0]?.url.startsWith('https://connectapi.garmin.com/usersummary-service/usersummary/daily/')).toBe(true);
    expect(calls[0]?.url).not.toContain('//evil');
  });
});

describe('replies', () => {
  it('an empty 200 body means "no data" (HRV on a night the watch was not worn)', async () => {
    for (const body of ['', '  \n', 'null']) {
      const { client } = setup(() => reply(200, body));
      expect(await client.hrv('2026-11-09'), JSON.stringify(body)).toEqual({ status: 200, empty: true, data: null });
    }
    const { client } = setup(() => reply(204));
    expect(await client.hrv('2026-11-09')).toEqual({ status: 204, empty: true, data: null });
  });

  it('404 and 403 are http errors that count as "no data", with no retry', async () => {
    for (const status of [404, 403]) {
      const { client, calls } = setup(() => reply(status, 'nothing here'));
      const e = (await client.hrv('2026-11-09').catch((x: unknown) => x)) as GarminError;
      expect(e).toBeInstanceOf(GarminError);
      expect(e.kind).toBe('http');
      expect(e.status).toBe(status);
      expect(isNoData(e)).toBe(true);
      expect(isFatalForRun(e)).toBe(false);
      expect(calls).toHaveLength(1);
    }
  });

  it('a body that is not JSON is a parse error that does not echo the body', async () => {
    const { client } = setup(() => reply(200, 'SECRET-HEALTH-DATA <html>'));
    const e = (await client.hrv('2026-11-09').catch((x: unknown) => x)) as GarminError;
    expect(e.kind).toBe('parse');
    expect(`${e.message} ${JSON.stringify(e)}`).not.toContain('SECRET-HEALTH-DATA');
  });
});

describe('token handling', () => {
  it('refreshes BEFORE the request when the token has 120 s or less left', async () => {
    const clock = createClock();
    const { client, calls } = setup(
      (c) => (c.url === DI_TOKEN_URL ? json(200, { access_token: FRESH, refresh_token: 'rotated' }) : json(200, {})),
      { tokens: { ...TOKENS, diToken: accessToken(120) }, now: clock.now, sleep: clock.sleep },
    );
    await client.profile();
    expect(calls.map((c) => c.url === DI_TOKEN_URL)).toEqual([true, false]);
    expect(calls[1]?.init.headers.Authorization).toBe(`Bearer ${FRESH}`);
  });

  it('does not refresh a token that has more than 120 s left', async () => {
    const { client, calls } = setup(() => json(200, {}), { tokens: { ...TOKENS, diToken: accessToken(121) } });
    await client.profile();
    expect(calls).toHaveLength(1);
  });

  it('refreshes once on a 401 and asks again with the new token', async () => {
    const { client, calls } = setup((c) => {
      if (c.url === DI_TOKEN_URL) return json(200, { access_token: FRESH, refresh_token: 'rotated' });
      return c.init.headers.Authorization === `Bearer ${FRESH}` ? json(200, { ok: true }) : reply(401, 'expired');
    });
    expect(await client.profile()).toMatchObject({ status: 200, data: { ok: true } });
    expect(calls.map((c) => (c.url === DI_TOKEN_URL ? 'token' : `data:${c.init.headers.Authorization === `Bearer ${FRESH}` ? 'new' : 'old'}`))).toEqual([
      'data:old',
      'token',
      'data:new',
    ]);
    expectReadOnly(calls);
  });

  it('gives up with "unauthorized" when a fresh token is refused too (no refresh loop)', async () => {
    const { client, calls } = setup((c) => (c.url === DI_TOKEN_URL ? json(200, { access_token: FRESH }) : reply(401)));
    const e = (await client.profile().catch((x: unknown) => x)) as GarminError;
    expect(e.kind).toBe('unauthorized');
    expect(isFatalForRun(e)).toBe(true);
    expect(calls).toHaveLength(3); // data 401, token, data 401
  });

  it('a refresh that was already done for this request is not repeated after a 401', async () => {
    const { client, calls } = setup(
      (c) => (c.url === DI_TOKEN_URL ? json(200, { access_token: FRESH }) : reply(401)),
      { tokens: { ...TOKENS, diToken: accessToken(10) } },
    );
    const e = (await client.profile().catch((x: unknown) => x)) as GarminError;
    expect(e.kind).toBe('unauthorized');
    expect(calls.filter((c) => c.url === DI_TOKEN_URL)).toHaveLength(1);
  });

  it('hands every new token pair to onTokensChanged (the refresh token may rotate) and uses it from then on', async () => {
    const saved: GarminTokens[] = [];
    let refreshes = 0;
    const { client, calls } = setup(
      (c) => {
        if (c.url === DI_TOKEN_URL) {
          refreshes += 1;
          return json(200, { access_token: refreshes === 1 ? FRESH : accessToken(9000), refresh_token: `rotated-${refreshes}` });
        }
        return json(200, {});
      },
      { tokens: { ...TOKENS, diToken: accessToken(10) }, onTokensChanged: (t) => void saved.push(t) },
    );
    await client.profile();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ diToken: FRESH, diRefreshToken: 'rotated-1', diClientId: DEFAULT_CLIENT_ID });
    expect(client.getTokens()).toEqual(saved[0]);

    // the next refresh presents the ROTATED refresh token
    const second = setup(
      (c) => (c.url === DI_TOKEN_URL ? json(200, { access_token: accessToken(9000) }) : json(200, {})),
      { tokens: { ...saved[0]!, diToken: accessToken(5) } },
    );
    await second.client.profile();
    expect(new URLSearchParams(second.calls[0]?.init.body).get('refresh_token')).toBe('rotated-1');
    void calls;
  });

  it('awaits onTokensChanged, and a failing save ends the request with a storage error (no data request is sent)', async () => {
    const order: string[] = [];
    const { client, calls } = setup(
      (c) => {
        order.push(c.url === DI_TOKEN_URL ? 'token' : 'data');
        return c.url === DI_TOKEN_URL ? json(200, { access_token: FRESH, refresh_token: 'rotated' }) : json(200, {});
      },
      {
        tokens: { ...TOKENS, diToken: accessToken(10) },
        onTokensChanged: async () => {
          await Promise.resolve();
          throw new Error('keychain locked');
        },
      },
    );
    const e = (await client.profile().catch((x: unknown) => x)) as GarminError;
    expect(e.kind).toBe('storage');
    expect(isFatalForRun(e)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(order).toEqual(['token']);
    expect(e.message).not.toContain('rotated');
  });

  it('HTTP 400 / 401 from the refresh = a dead session: stop at once, no retry, no data request', async () => {
    for (const status of [400, 401]) {
      const { client, calls } = setup(() => json(status, { error: 'invalid_grant' }), { tokens: { ...TOKENS, diToken: accessToken(0) } });
      const e = (await client.profile().catch((x: unknown) => x)) as GarminError;
      expect(e.kind).toBe('session_dead');
      expect(isFatalForRun(e)).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(DI_TOKEN_URL);
    }
  });

  it('never shows a token in any error', async () => {
    const { client } = setup(() => reply(500, `boom ${VALID} ${REFRESH_TOKEN}`));
    const e = (await client.profile().catch((x: unknown) => x)) as GarminError;
    const text = `${e.message} ${e.userMessage} ${e.detail ?? ''} ${JSON.stringify(e)}`;
    expect(text).not.toContain(VALID);
    expect(text).not.toContain(REFRESH_TOKEN);
  });
});

describe('retries and backoff', () => {
  it('computes the pause: 1 s, then 3 s; a Retry-After value wins, capped at 30 s', () => {
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(2)).toBe(3000);
    expect(backoffMs(3)).toBe(3000);
    expect(backoffMs(1, 7)).toBe(7000);
    expect(backoffMs(2, 600)).toBe(30_000);
    expect(backoffMs(1, 0)).toBe(0);
  });

  it('retries a 5xx twice with 1 s then 3 s pauses and then reports a server error', async () => {
    const { client, calls, clock } = setup(() => reply(503));
    const e = (await client.hrv('2026-11-09').catch((x: unknown) => x)) as GarminError;
    expect(e.kind).toBe('server');
    expect(e.status).toBe(503);
    expect(calls).toHaveLength(3);
    // pauses between attempts: backoff only (the 250 ms spacing is already covered by the backoff)
    expect(clock.sleeps.filter((ms) => ms >= 1000)).toEqual([1000, 3000]);
  });

  it('recovers when a retry succeeds', async () => {
    let n = 0;
    const { client, calls } = setup(() => (++n < 3 ? reply(502) : json(200, { ok: 1 })));
    expect(await client.hrv('2026-11-09')).toMatchObject({ data: { ok: 1 } });
    expect(calls).toHaveLength(3);
  });

  it('honours Retry-After on a 429 (capped at 30 s) and then stops with rate_limited', async () => {
    const { client, calls, clock } = setup(() => reply(429, '', { 'Retry-After': '600' }));
    const e = (await client.hrv('2026-11-09').catch((x: unknown) => x)) as GarminError;
    expect(e.kind).toBe('rate_limited');
    expect(e.retryAfterSeconds).toBe(600);
    expect(isFatalForRun(e)).toBe(true);
    expect(calls).toHaveLength(3);
    expect(clock.sleeps.filter((ms) => ms >= 1000)).toEqual([30_000, 30_000]);

    const small = setup(() => reply(429, '', { 'retry-after': '7' }));
    await small.client.hrv('2026-11-09').catch(() => undefined);
    expect(small.clock.sleeps.filter((ms) => ms >= 1000)).toEqual([7000, 7000]);
  });

  it('retries a dropped connection, then reports a network error', async () => {
    const { client, calls } = setup(() => new Error('offline'));
    const e = (await client.hrv('2026-11-09').catch((x: unknown) => x)) as GarminError;
    expect(e.kind).toBe('network');
    expect(isFatalForRun(e)).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('times out a request that never answers', async () => {
    const hung = vi.fn(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise<never>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    );
    const clock = createClock();
    const client = new GarminConnectClient({ fetch: hung as never, tokens: TOKENS, now: clock.now, sleep: clock.sleep, timeoutMs: 10 });
    const e = (await client.hrv('2026-11-09').catch((x: unknown) => x)) as GarminError;
    expect(e.kind).toBe('timeout');
    expect(hung).toHaveBeenCalledTimes(3);
  });

  it('does not retry client errors or an empty body', async () => {
    const { client, calls } = setup(() => reply(400, 'bad'));
    await client.hrv('2026-11-09').catch(() => undefined);
    expect(calls).toHaveLength(1);
  });
});

describe('pacing', () => {
  it('sends requests one at a time even when the caller does not wait (no parallel burst)', async () => {
    const clock = createClock();
    const { client, maxInFlight, calls } = setup(
      async () => {
        await new Promise((r) => setTimeout(r, 2)); // really slow answers
        return json(200, {});
      },
      { now: clock.now, sleep: clock.sleep },
    );
    await Promise.all([client.profile(), client.hrv('2026-11-09'), client.hrv('2026-11-08'), client.activities(0, 50), client.weightRange('a', 'b')]);
    expect(calls).toHaveLength(5);
    expect(maxInFlight()).toBe(1);
  });

  it('keeps the starts of two requests at least 250 ms apart', async () => {
    const clock = createClock();
    const starts: number[] = [];
    const { client } = setup(
      () => {
        starts.push(clock.now());
        return json(200, {});
      },
      { now: clock.now, sleep: clock.sleep },
    );
    for (let i = 0; i < 6; i++) await client.hrv('2026-11-09');
    expect(starts).toHaveLength(6);
    for (let i = 1; i < starts.length; i++) expect((starts[i] as number) - (starts[i - 1] as number)).toBeGreaterThanOrEqual(250);
    expect(clock.sleeps).toEqual([250, 250, 250, 250, 250]);
  });

  it('does not wait when enough time has passed anyway', async () => {
    const clock = createClock();
    const { client } = setup(() => json(200, {}), { now: clock.now, sleep: clock.sleep });
    await client.hrv('2026-11-09');
    clock.advance(1000);
    await client.hrv('2026-11-08');
    expect(clock.sleeps).toEqual([]);
  });

  it('paces the token refresh like any other request', async () => {
    const clock = createClock();
    const { client } = setup(
      (c) => (c.url === DI_TOKEN_URL ? json(200, { access_token: FRESH }) : reply(c.init.headers.Authorization === `Bearer ${FRESH}` ? 200 : 401, '{}')),
      { now: clock.now, sleep: clock.sleep },
    );
    await client.hrv('2026-11-09');
    expect(clock.sleeps).toEqual([250, 250]);
  });

  it('the pacing can be configured', async () => {
    const clock = createClock();
    const { client } = setup(() => json(200, {}), { now: clock.now, sleep: clock.sleep, spacingMs: 1000 });
    await client.hrv('2026-11-09');
    await client.hrv('2026-11-08');
    expect(clock.sleeps).toEqual([1000]);
  });

  it('a failed request does not block the queue', async () => {
    let n = 0;
    const { client } = setup(() => (++n === 1 ? reply(404) : json(200, { ok: 1 })));
    const [a, b] = await Promise.allSettled([client.hrv('2026-11-09'), client.hrv('2026-11-08')]);
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('fulfilled');
  });
});

describe('one activity (workout details)', () => {
  const ID = '12345678901';

  it('uses the reference endpoint paths, GET only, on the Connect API host', async () => {
    const { client, calls } = setup(() => json(200, {}));
    await client.activity(ID);
    await client.activityHrZones(ID);
    await client.activityExerciseSets(ID);
    await client.activitySplits(12345678901);
    expect(calls.map((c) => c.url.slice(CONNECT_API_BASE.length))).toEqual([
      `/activity-service/activity/${ID}`,
      `/activity-service/activity/${ID}/hrTimeInZones`,
      `/activity-service/activity/${ID}/exerciseSets`,
      `/activity-service/activity/${ID}/splits`,
    ]);
    expectReadOnly(calls);
    for (const c of calls) expect(c.init.headers.Authorization).toBe(`Bearer ${VALID}`);
  });

  it('only accept a numeric activity id (no path tricks) and never send a request for anything else', async () => {
    const { client, calls } = setup(() => json(200, {}));
    for (const bad of ['', '12a', '../../x', '1/2', '12 34', 'garmin:activity:5', '1e9', -5, 1.5, Number.NaN, '9'.repeat(25)]) {
      const e = (await client.activity(bad as never).catch((x: unknown) => x)) as GarminError;
      expect(e, String(bad)).toBeInstanceOf(GarminError);
      expect(e.kind, String(bad)).toBe('bad_request');
    }
    expect(calls).toHaveLength(0);
  });

  it('are queued one at a time, 250 ms apart, even when started together', async () => {
    const clock = createClock();
    const starts: number[] = [];
    const { client, maxInFlight, calls } = setup(
      () => {
        starts.push(clock.now());
        return json(200, {});
      },
      { now: clock.now, sleep: clock.sleep },
    );
    await Promise.all([client.activity(ID), client.activityHrZones(ID), client.activityExerciseSets(ID), client.activitySplits(ID)]);
    expect(calls).toHaveLength(4);
    expect(maxInFlight()).toBe(1);
    for (let i = 1; i < starts.length; i++) expect((starts[i] as number) - (starts[i - 1] as number)).toBeGreaterThanOrEqual(250);
  });

  it('refresh once on a 401 and ask again; a second 401 is "unauthorized"', async () => {
    const { client, calls } = setup((c) => {
      if (c.url === DI_TOKEN_URL) return json(200, { access_token: FRESH, refresh_token: 'rotated' });
      return c.init.headers.Authorization === `Bearer ${FRESH}` ? json(200, { zones: 1 }) : reply(401);
    });
    expect(await client.activityHrZones(ID)).toMatchObject({ status: 200, data: { zones: 1 } });
    expect(calls.map((c) => (c.url === DI_TOKEN_URL ? 'token' : 'data'))).toEqual(['data', 'token', 'data']);
    expectReadOnly(calls);

    const dead = setup((c) => (c.url === DI_TOKEN_URL ? json(200, { access_token: FRESH }) : reply(401)));
    const e = (await dead.client.activity(ID).catch((x: unknown) => x)) as GarminError;
    expect(e.kind).toBe('unauthorized');
  });

  it('a 429 is retried with Retry-After (capped), then reported as rate_limited', async () => {
    const { client, calls, clock } = setup(() => reply(429, '', { 'Retry-After': '120' }));
    const e = (await client.activityExerciseSets(ID).catch((x: unknown) => x)) as GarminError;
    expect(e.kind).toBe('rate_limited');
    expect(e.retryAfterSeconds).toBe(120);
    expect(isFatalForRun(e)).toBe(true);
    expect(calls).toHaveLength(3);
    expect(clock.sleeps.filter((ms) => ms >= 1000)).toEqual([30_000, 30_000]);
  });

  it('an empty body, a 204 and a JSON null mean "no data"; a 404 is a no-data http error', async () => {
    for (const r of [reply(200, ''), reply(200, '  '), reply(200, 'null'), reply(204)]) {
      const { client } = setup(() => r);
      expect(await client.activitySplits(ID)).toMatchObject({ empty: true, data: null });
    }
    const { client, calls } = setup(() => reply(404));
    const e = (await client.activityHrZones(ID).catch((x: unknown) => x)) as GarminError;
    expect(isNoData(e)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('a body that is not JSON is a parse error that does not echo the body', async () => {
    const { client } = setup(() => reply(200, 'SECRET-HEART-RATES <html>'));
    const e = (await client.activity(ID).catch((x: unknown) => x)) as GarminError;
    expect(e.kind).toBe('parse');
    expect(`${e.message} ${JSON.stringify(e)}`).not.toContain('SECRET-HEART-RATES');
  });
});
