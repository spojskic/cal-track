import { describe, expect, it } from 'vitest';
import { base64Encode, formEncode } from './base64';
import { referenceBase64 } from './test-utils';

describe('base64Encode', () => {
  it('matches the platform btoa for ASCII and UTF-8, with padding', () => {
    for (const s of ['', 'f', 'fo', 'foo', 'foobar', 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2:', 'čćžšđ 😀', '\u00ff\u0800']) {
      expect(base64Encode(s), s).toBe(referenceBase64(s));
    }
  });
});

describe('formEncode', () => {
  it('percent-encodes keys and values', () => {
    expect(
      formEncode([
        ['grant_type', 'https://connectapi.garmin.com/x'],
        ['a b', 'c&d=e'],
      ]),
    ).toBe('grant_type=https%3A%2F%2Fconnectapi.garmin.com%2Fx&a%20b=c%26d%3De');
    expect(formEncode([])).toBe('');
  });
});
