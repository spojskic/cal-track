import { describe, expect, it } from 'vitest';
import { classifyHttpError, GarminError, isFatalAuthError, parseErrorBody, redactSecrets, toGarminError, USER_MESSAGES } from './errors';
import { KEY, makeJwt } from './test-utils';

describe('redactSecrets', () => {
  it('removes exact secrets, key-shaped strings, bearer tokens and JWTs', () => {
    const jwt = makeJwt({ exp: 1 });
    const text = `key ${KEY} other GCDC_abc-DEF_123 hdr Authorization: Bearer ${jwt} ApiKey zzzzzzzz jwt ${jwt} custom MYSECRETVALUE`;
    const out = redactSecrets(text, ['MYSECRETVALUE']);
    expect(out).not.toContain(KEY);
    expect(out).not.toContain('GCDC_abc');
    expect(out).not.toContain(jwt);
    expect(out).not.toContain('MYSECRETVALUE');
    expect(out).not.toContain('zzzzzzzz');
    expect(out).toContain('[redacted]');
  });
  it('leaves harmless text alone and ignores tiny secrets', () => {
    expect(redactSecrets('HTTP 500 at /sleep-service', ['a'])).toBe('HTTP 500 at /sleep-service');
  });
});

describe('GarminError', () => {
  it('has friendly defaults per kind and the exact invalid-key message', () => {
    const e = new GarminError({ kind: 'invalid_key', status: 401 });
    expect(e.userMessage).toBe(
      'Garmin rejected this key. Create a new Personal API key in Garmin Connect (it may have expired or been deleted).',
    );
    expect(e.retryable).toBe(false);
    expect(e.name).toBe('GarminError');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(GarminError);
  });
  it('every kind has a non-empty message and the right retryable flag', () => {
    const retryable = ['rate_limited', 'server', 'network', 'timeout'];
    for (const kind of ['invalid_key', 'key_expired_or_revoked', 'unauthorized', 'rate_limited', 'not_acceptable', 'bad_request', 'server', 'network', 'timeout', 'unexpected'] as const) {
      const e = new GarminError({ kind });
      expect(e.userMessage.length).toBeGreaterThan(10);
      expect(e.retryable).toBe(retryable.includes(kind));
      expect(e.message).toContain(kind);
    }
  });
  it('403 data errors explain the missing permission', () => {
    expect(new GarminError({ kind: 'unauthorized', status: 403 }).userMessage).toBe(USER_MESSAGES.forbidden);
    expect(new GarminError({ kind: 'unauthorized', status: 401 }).userMessage).toBe(USER_MESSAGES.unauthorized);
  });
  it('redacts secrets in every text field in the constructor', () => {
    const jwt = makeJwt({ exp: 2 });
    const e = new GarminError({
      kind: 'network',
      message: `failed with ${KEY}`,
      userMessage: `see ${jwt}`,
      detail: `Bearer ${jwt}`,
      errorId: KEY,
      secrets: ['plainsecret'],
    });
    const dump = JSON.stringify(e) + e.message + e.userMessage + String(e.stack ?? '').split('\n')[0];
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain(jwt);
  });
  it('does not keep a cause', () => {
    const e = new GarminError({ kind: 'network' });
    expect('cause' in e).toBe(false);
  });
  it('toJSON is plain data', () => {
    const e = new GarminError({ kind: 'rate_limited', status: 429, retryAfterSeconds: 12 });
    expect(JSON.parse(JSON.stringify(e))).toMatchObject({ kind: 'rate_limited', status: 429, retryAfterSeconds: 12, retryable: true });
  });
});

describe('parseErrorBody', () => {
  it('reads errorId, message and retryInSeconds', () => {
    expect(parseErrorBody('{"errorId":"E-77","message":"slow down","retryInSeconds":"12"}')).toEqual({ errorId: 'E-77', message: 'slow down', retryInSeconds: 12 });
    expect(parseErrorBody('{"errorId":5,"retryInSeconds":3}')).toMatchObject({ errorId: '5', retryInSeconds: 3 });
  });
  it('never throws', () => {
    expect(parseErrorBody('{bad json')).toEqual({ message: '{bad json' });
    expect(parseErrorBody('plain text')).toEqual({ message: 'plain text' });
    expect(parseErrorBody('')).toEqual({});
    expect(parseErrorBody(null)).toEqual({});
    expect(parseErrorBody('{"retryInSeconds":-4}')).toEqual({});
    expect(parseErrorBody('{"retryInSeconds":{"a":1}}')).toEqual({});
  });
});

describe('classifyHttpError', () => {
  const token = (status: number, extra: object = {}) => classifyHttpError({ status, phase: 'token', ...extra });
  const data = (status: number, extra: object = {}) => classifyHttpError({ status, phase: 'data', ...extra });

  it('token 401/403/400 -> invalid_key; after a success or expired text -> key_expired_or_revoked', () => {
    for (const s of [400, 401, 403]) expect(token(s).kind).toBe('invalid_key');
    expect(token(401, { keyWorkedBefore: true }).kind).toBe('key_expired_or_revoked');
    expect(token(403, { bodyText: '{"message":"Key has expired"}' }).kind).toBe('key_expired_or_revoked');
    expect(token(401, { bodyText: '{"errorId":"KEY_REVOKED"}' }).kind).toBe('key_expired_or_revoked');
  });
  it('406 -> not_acceptable', () => {
    expect(token(406).kind).toBe('not_acceptable');
    expect(data(406).kind).toBe('not_acceptable');
  });
  it('429 -> rate_limited with retry seconds from body, else header', () => {
    const a = data(429, { bodyText: '{"errorId":"RATE","retryInSeconds":17}' });
    expect(a.kind).toBe('rate_limited');
    expect(a.retryAfterSeconds).toBe(17);
    expect(a.errorId).toBe('RATE');
    expect(a.retryable).toBe(true);
    expect(data(429, { retryAfterHeaderSec: 9 }).retryAfterSeconds).toBe(9);
    expect(data(429).retryAfterSeconds).toBeUndefined();
  });
  it('5xx -> server (retryable), other 4xx -> bad_request, data 401/403 -> unauthorized', () => {
    for (const s of [500, 502, 503, 504]) {
      const e = data(s);
      expect(e.kind).toBe('server');
      expect(e.retryable).toBe(true);
    }
    for (const s of [400, 404, 422]) expect(data(s).kind).toBe('bad_request');
    expect(data(401).kind).toBe('unauthorized');
    expect(data(403).kind).toBe('unauthorized');
    expect(data(403).status).toBe(403);
    expect(data(408).kind).toBe('timeout');
    expect(token(404).kind).toBe('bad_request');
    expect(data(302).kind).toBe('unexpected');
  });
  it('redacts echoed secrets from the body and detail', () => {
    const jwt = makeJwt({ exp: 9 });
    const e = data(500, { bodyText: JSON.stringify({ message: `bad token ${jwt} / ${KEY}` }), path: '/x', secrets: [KEY, jwt] });
    expect(JSON.stringify(e)).not.toContain(KEY);
    expect(JSON.stringify(e)).not.toContain(jwt);
    expect(e.detail).toContain('/x');
  });
});

describe('isFatalAuthError / toGarminError', () => {
  it('fatal: bad key and 401; not fatal: 403 scope errors and others', () => {
    expect(isFatalAuthError(new GarminError({ kind: 'invalid_key' }))).toBe(true);
    expect(isFatalAuthError(new GarminError({ kind: 'key_expired_or_revoked' }))).toBe(true);
    expect(isFatalAuthError(new GarminError({ kind: 'unauthorized', status: 401 }))).toBe(true);
    expect(isFatalAuthError(new GarminError({ kind: 'unauthorized', status: 403 }))).toBe(false);
    expect(isFatalAuthError(new GarminError({ kind: 'server' }))).toBe(false);
    expect(isFatalAuthError(new Error('x'))).toBe(false);
    expect(isFatalAuthError(null)).toBe(false);
  });
  it('wraps unknown throwables', () => {
    expect(toGarminError(new Error('boom')).kind).toBe('unexpected');
    expect(toGarminError('str').kind).toBe('unexpected');
    expect(toGarminError(undefined).kind).toBe('unexpected');
    const g = new GarminError({ kind: 'server' });
    expect(toGarminError(g)).toBe(g);
    expect(toGarminError(new Error(`leak ${KEY}`), [KEY]).message).not.toContain(KEY);
  });
});
