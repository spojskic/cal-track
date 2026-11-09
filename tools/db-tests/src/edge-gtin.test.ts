import { describe, expect, it } from 'vitest';
import {
  computeCheckDigit,
  fdcQueryCode,
  hasValidCheckDigit,
  normalizeGtin,
  offProductCode,
  toGtin14,
} from '../../../supabase/functions/_shared/gtin.ts';

describe('GS1 check digit', () => {
  it.each([
    ['UPC-A', '036000291452'],
    ['EAN-13', '4006381333931'],
    ['EAN-8', '96385074'],
    ['GTIN-14', '10012345678902'],
  ])('accepts a valid %s (%s)', (_label, code) => {
    expect(hasValidCheckDigit(code)).toBe(true);
  });

  it('rejects a wrong check digit', () => {
    expect(hasValidCheckDigit('036000291453')).toBe(false);
    expect(hasValidCheckDigit('4006381333932')).toBe(false);
  });

  it('computeCheckDigit makes every body valid', () => {
    for (const body of ['0360002914', '40063813339', '9638507', '1001234567890', '1']) {
      const code = body + computeCheckDigit(body);
      expect(hasValidCheckDigit(code), code).toBe(true);
    }
  });

  it('is unchanged by left zero padding (UPC-A == EAN-13 == GTIN-14)', () => {
    expect(hasValidCheckDigit('0036000291452')).toBe(true);
    expect(hasValidCheckDigit('00036000291452')).toBe(true);
  });

  it('refuses non-digit and too-short input', () => {
    expect(hasValidCheckDigit('')).toBe(false);
    expect(hasValidCheckDigit('7')).toBe(false);
    expect(hasValidCheckDigit('12a4')).toBe(false);
  });
});

describe('normalizeGtin', () => {
  it('left-pads every standard length to GTIN-14 without a warning', () => {
    expect(normalizeGtin('036000291452')).toEqual({
      ok: true,
      gtin14: '00036000291452',
      digits: '036000291452',
    });
    expect(normalizeGtin('4006381333931')).toMatchObject({ ok: true, gtin14: '04006381333931' });
    expect(normalizeGtin('96385074')).toMatchObject({ ok: true, gtin14: '00000096385074' });
    expect(normalizeGtin('10012345678902')).toMatchObject({ ok: true, gtin14: '10012345678902' });
  });

  it('UPC-A and the EAN-13 with a leading zero normalise to the same GTIN-14', () => {
    const a = normalizeGtin('036000291452');
    const b = normalizeGtin('0036000291452');
    expect(a.ok && b.ok && a.gtin14 === b.gtin14).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeGtin('  4006381333931\n')).toMatchObject({
      ok: true,
      gtin14: '04006381333931',
    });
  });

  it('accepts a failing check digit but flags it', () => {
    const r = normalizeGtin('4006381333932');
    expect(r).toMatchObject({ ok: true, gtin14: '04006381333932', warning: 'invalid_check_digit' });
  });

  it('accepts odd lengths with a nonstandard_length warning', () => {
    expect(normalizeGtin('12345')).toMatchObject({
      ok: true,
      gtin14: '00000000012345',
      warning: 'nonstandard_length',
    });
    expect(normalizeGtin('12345678901')).toMatchObject({ ok: true, warning: 'nonstandard_length' });
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['letters', '40063813339x1'],
    ['hyphens', '4006-3813-3393-1'],
    ['internal space', '4006 381333931'],
    ['too long', '123456789012345'],
    ['all zeros', '0000000000000'],
    ['number', 4006381333931],
    ['null', null],
    ['undefined', undefined],
    ['object', {}],
  ])('rejects %s', (_label, input) => {
    expect(normalizeGtin(input)).toMatchObject({ ok: false, error: 'invalid_gtin' });
  });
});

describe('toGtin14 (lenient, for source data)', () => {
  it('pads strings and safe integers, no check digit validation', () => {
    expect(toGtin14('009800895007')).toBe('00009800895007');
    expect(toGtin14(9800895007)).toBe('00009800895007');
    expect(toGtin14('4006381333932')).toBe('04006381333932');
  });
  it('returns null for unusable values', () => {
    for (const v of ['', '0', '000', 'abc', '1'.repeat(15), null, undefined, -5, 1.5, {}]) {
      expect(toGtin14(v), String(v)).toBeNull();
    }
  });
});

describe('source-specific code forms', () => {
  it('FDC query uses UPC-A (12), EAN-13 or the GTIN-14 digits', () => {
    expect(fdcQueryCode('00036000291452')).toBe('036000291452');
    expect(fdcQueryCode('04006381333931')).toBe('4006381333931');
    expect(fdcQueryCode('10012345678902')).toBe('10012345678902');
    expect(fdcQueryCode('00000096385074')).toBe('96385074');
  });
  it('OFF product code uses EAN-13 (UPC-A gets a leading zero), EAN-8, or 14 digits', () => {
    expect(offProductCode('00036000291452')).toBe('0036000291452');
    expect(offProductCode('04006381333931')).toBe('4006381333931');
    expect(offProductCode('00000096385074')).toBe('96385074');
    expect(offProductCode('10012345678902')).toBe('10012345678902');
  });
});
