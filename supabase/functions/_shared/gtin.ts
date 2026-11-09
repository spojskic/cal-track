/**
 * GTIN / UPC / EAN helpers (pure, dependency-free).
 *
 * Everything is normalised to GTIN-14 (left-padded with zeros), the format of
 * `foods.gtin14`. A UPC-A (12 digits), an EAN-13 and an EAN-8 therefore map to
 * 14-digit strings that compare equal when they denote the same item
 * (UPC-A `036000291452` == EAN-13 `0036000291452` == GTIN-14 `00036000291452`).
 */

/** Lengths for which a GS1 check digit is defined (GTIN-8/12/13/14). */
const STANDARD_LENGTHS = new Set([8, 12, 13, 14]);

export type GtinWarning = 'invalid_check_digit' | 'nonstandard_length';

export type GtinParse =
  | { ok: true; gtin14: string; digits: string; warning?: GtinWarning }
  | { ok: false; error: 'invalid_gtin'; message: string };

/**
 * GS1 check digit for a code BODY (all digits except the last one):
 * counting from the right, digits get weights 3, 1, 3, 1, ...;
 * check = (10 - sum mod 10) mod 10.
 */
export function computeCheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const digit = body.charCodeAt(body.length - 1 - i) - 48;
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/** True when the LAST digit of `digits` is the correct GS1 check digit of the rest. */
export function hasValidCheckDigit(digits: string): boolean {
  if (!/^\d{2,}$/.test(digits)) return false;
  return computeCheckDigit(digits.slice(0, -1)) === digits.charCodeAt(digits.length - 1) - 48;
}

/**
 * Validates and normalises a user-supplied GTIN.
 *
 * - must be a string of 1-14 digits (surrounding whitespace is trimmed; any
 *   other character, an empty string or an all-zero code is rejected);
 * - the GS1 check digit is verified for 8/12/13/14-digit codes. A failing check
 *   digit is NOT an error (some Open Food Facts products carry bad codes): the
 *   result is accepted with `warning: 'invalid_check_digit'`;
 * - other lengths (1-7, 9-11) are accepted with `warning: 'nonstandard_length'`.
 */
export function normalizeGtin(input: unknown): GtinParse {
  if (typeof input !== 'string') {
    return { ok: false, error: 'invalid_gtin', message: 'gtin must be a string of digits' };
  }
  const digits = input.trim();
  if (digits === '') {
    return { ok: false, error: 'invalid_gtin', message: 'gtin must not be empty' };
  }
  if (!/^\d+$/.test(digits)) {
    return { ok: false, error: 'invalid_gtin', message: 'gtin must contain digits only' };
  }
  if (digits.length > 14) {
    return { ok: false, error: 'invalid_gtin', message: 'gtin must have at most 14 digits' };
  }
  if (/^0+$/.test(digits)) {
    return { ok: false, error: 'invalid_gtin', message: 'gtin must not be all zeros' };
  }
  const gtin14 = digits.padStart(14, '0');
  if (!STANDARD_LENGTHS.has(digits.length)) {
    return { ok: true, gtin14, digits, warning: 'nonstandard_length' };
  }
  if (!hasValidCheckDigit(gtin14)) {
    return { ok: true, gtin14, digits, warning: 'invalid_check_digit' };
  }
  return { ok: true, gtin14, digits };
}

/**
 * Lenient normalisation for codes coming from data sources (FDC `gtinUpc`,
 * OFF `code`): digits only (number or string), 1-14 digits, not all zeros,
 * no check-digit validation. Returns the GTIN-14 or null.
 */
export function toGtin14(input: unknown): string | null {
  let s: string;
  if (typeof input === 'string') s = input.trim();
  else if (typeof input === 'number' && Number.isSafeInteger(input) && input > 0) s = String(input);
  else return null;
  if (!/^\d{1,14}$/.test(s) || /^0+$/.test(s)) return null;
  return s.padStart(14, '0');
}

/**
 * The form of a GTIN-14 to put into an FDC text search. FDC stores `gtinUpc`
 * mostly as 12-digit UPC-A (also 13/14 digits for EAN items), without the
 * padding zeros we add.
 */
export function fdcQueryCode(gtin14: string): string {
  const significant = gtin14.replace(/^0+/, '');
  if (significant.length <= 8) return significant.padStart(8, '0');
  if (significant.length <= 12) return significant.padStart(12, '0');
  return significant;
}

/**
 * The form of a GTIN-14 to request from Open Food Facts: EAN-8 for short
 * codes, EAN-13 for UPC-A / EAN-13 (OFF stores a UPC-A with a leading 0) and
 * the full 14 digits otherwise.
 */
export function offProductCode(gtin14: string): string {
  const significant = gtin14.replace(/^0+/, '');
  if (significant.length <= 8) return significant.padStart(8, '0');
  if (significant.length <= 13) return significant.padStart(13, '0');
  return significant;
}
