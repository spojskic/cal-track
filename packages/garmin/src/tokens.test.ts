import { describe, expect, it } from 'vitest';
import { EXPIRY_SKEW_SEC } from './constants';
import { clientIdFromJwt, isGarminTokens, isTokenExpired, tokenExpiresInSec } from './tokens';
import { NOW_MS, NOW_SEC, accessToken, makeJwt } from './test-utils';

describe('JWT expiry', () => {
  it('reads exp and returns the seconds left', () => {
    expect(tokenExpiresInSec({ diToken: makeJwt({ exp: NOW_SEC + 600 }) }, NOW_MS)).toBe(600);
    expect(tokenExpiresInSec({ diToken: makeJwt({ exp: NOW_SEC - 30 }) }, NOW_MS)).toBe(-30);
    expect(tokenExpiresInSec({ diToken: makeJwt({ exp: String(NOW_SEC + 5) }) }, NOW_MS)).toBe(5);
  });
  it('is null for anything that is not a readable JWT with an exp', () => {
    for (const bad of ['', 'abc', 'a.b.c', makeJwt({ sub: 'x' }), makeJwt({ exp: 'soon' }), makeJwt({ exp: -1 }), makeJwt({ exp: null })]) {
      expect(tokenExpiresInSec({ diToken: bad }, NOW_MS), bad).toBeNull();
    }
  });
  it('is expired 120 s before exp, not later', () => {
    expect(EXPIRY_SKEW_SEC).toBe(120);
    expect(isTokenExpired({ diToken: accessToken(3600) }, NOW_MS)).toBe(false);
    expect(isTokenExpired({ diToken: accessToken(121) }, NOW_MS)).toBe(false);
    expect(isTokenExpired({ diToken: accessToken(120) }, NOW_MS)).toBe(true);
    expect(isTokenExpired({ diToken: accessToken(60) }, NOW_MS)).toBe(true);
    expect(isTokenExpired({ diToken: accessToken(-10) }, NOW_MS)).toBe(true);
  });
  it('treats an unreadable token as expired ("refresh now"), never as valid', () => {
    expect(isTokenExpired({ diToken: 'not-a-jwt' }, NOW_MS)).toBe(true);
    expect(isTokenExpired({ diToken: '' }, NOW_MS)).toBe(true);
  });
  it('accepts a custom skew', () => {
    expect(isTokenExpired({ diToken: accessToken(200) }, NOW_MS, 300)).toBe(true);
    expect(isTokenExpired({ diToken: accessToken(200) }, NOW_MS, 100)).toBe(false);
  });
});

describe('clientIdFromJwt', () => {
  it('reads the client_id claim', () => {
    expect(clientIdFromJwt(makeJwt({ client_id: 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4' }))).toBe('GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4');
    expect(clientIdFromJwt(makeJwt({ exp: 1 }))).toBeNull();
    expect(clientIdFromJwt(makeJwt({ client_id: '' }))).toBeNull();
    expect(clientIdFromJwt('junk')).toBeNull();
  });
});

describe('isGarminTokens', () => {
  it('needs all three non-empty strings', () => {
    expect(isGarminTokens({ diToken: 'a', diRefreshToken: 'b', diClientId: 'c' })).toBe(true);
    for (const bad of [null, undefined, 5, {}, { diToken: 'a', diRefreshToken: 'b' }, { diToken: '', diRefreshToken: 'b', diClientId: 'c' }, { diToken: 1, diRefreshToken: 'b', diClientId: 'c' }]) {
      expect(isGarminTokens(bad)).toBe(false);
    }
  });
});
