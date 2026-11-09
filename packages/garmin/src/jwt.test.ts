import { describe, expect, it } from 'vitest';
import { GarminError } from './errors';
import { base64UrlDecodeToString, base64UrlToBytes, decodeJwtExp, decodeJwtPayload, GarminJwtError, utf8BytesToString } from './jwt';
import { b64url, makeJwt } from './test-utils';

describe('base64url', () => {
  it('decodes padded and unpadded input', () => {
    expect(base64UrlDecodeToString('aGVsbG8')).toBe('hello');
    expect(base64UrlDecodeToString('aGVsbG8=')).toBe('hello');
    expect(base64UrlDecodeToString('aGk')).toBe('hi');
    expect(base64UrlDecodeToString('')).toBe('');
  });
  it('handles the url-safe alphabet', () => {
    // 0xfb 0xff -> '-_8' in base64url ('+/8=' in base64)
    expect(base64UrlToBytes('-_8')).toEqual([0xfb, 0xff]);
    expect(base64UrlToBytes('+/8=')).toEqual([0xfb, 0xff]);
  });
  it('rejects invalid characters and impossible lengths', () => {
    expect(base64UrlToBytes('ab$d')).toBeNull();
    expect(base64UrlToBytes('a')).toBeNull();
    expect(base64UrlToBytes('abcde')).toBeNull();
    expect(base64UrlToBytes('ab cd')).toBeNull();
  });
  it('decodes multi-byte UTF-8', () => {
    expect(base64UrlDecodeToString(b64url('Zdravo svijete, čćžšđ 😀'))).toBe('Zdravo svijete, čćžšđ 😀');
  });
  it('turns invalid UTF-8 into replacement characters instead of throwing', () => {
    expect(utf8BytesToString([0xff, 0x41])).toBe('\ufffdA');
    expect(utf8BytesToString([0xe2, 0x82])).toBe('\ufffd\ufffd');
  });
});

describe('decodeJwtExp', () => {
  it('reads exp in seconds', () => {
    expect(decodeJwtExp(makeJwt({ exp: 1_800_000_000, sub: 'x' }))).toBe(1_800_000_000);
  });
  it('accepts a numeric-string exp and surrounding whitespace', () => {
    expect(decodeJwtExp(`  ${makeJwt({ exp: '1800000001' })}\n`)).toBe(1_800_000_001);
  });
  it('throws a typed error for a wrong shape', () => {
    for (const bad of ['', 'abc', 'a.b', 'a.b.c.d', '..', 'x..y']) {
      expect(() => decodeJwtExp(bad)).toThrow(GarminJwtError);
    }
    try {
      decodeJwtExp('a.b');
    } catch (e) {
      expect(e).toBeInstanceOf(GarminError);
      expect((e as GarminJwtError).reason).toBe('shape');
      expect((e as GarminError).kind).toBe('unexpected');
    }
  });
  it('throws for bad base64, bad JSON, non-object JSON and missing/invalid exp', () => {
    expect(() => decodeJwtExp('aaa.b$d.ccc')).toThrow(/base64/);
    expect(() => decodeJwtExp(`aaa.${b64url('not json')}.ccc`)).toThrow(/json/);
    expect(() => decodeJwtExp(`aaa.${b64url('[1,2]')}.ccc`)).toThrow(/json/);
    expect(() => decodeJwtExp(`aaa.${b64url('"str"')}.ccc`)).toThrow(/json/);
    expect(() => decodeJwtExp(makeJwt({ sub: 'x' }))).toThrow(/no_exp/);
    expect(() => decodeJwtExp(makeJwt({ exp: 'soon' }))).toThrow(/no_exp/);
    expect(() => decodeJwtExp(makeJwt({ exp: -5 }))).toThrow(/no_exp/);
    expect(() => decodeJwtExp(makeJwt({ exp: null }))).toThrow(/no_exp/);
  });
  it('never puts the token into the error', () => {
    const token = makeJwt({ sub: 'secret-subject' });
    try {
      decodeJwtExp(token);
      expect.unreachable();
    } catch (e) {
      const err = e as GarminError;
      expect(err.message).not.toContain(token);
      expect(err.message).not.toContain('secret-subject');
      expect(JSON.stringify(err)).not.toContain(token);
    }
  });
  it('decodeJwtPayload returns the claims', () => {
    expect(decodeJwtPayload(makeJwt({ exp: 5, scope: 'a b' }))).toEqual({ exp: 5, scope: 'a b' });
  });
  it('rejects non-string input', () => {
    expect(() => decodeJwtExp(undefined as unknown as string)).toThrow(GarminJwtError);
  });
});
