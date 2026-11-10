// Pure (no React Native imports): what a code seen by the camera means for a food scanner.
import { expandUpcE, gtinDigits, validateBarcode } from '@/data/foods';

import { displayGtin } from './format';

/** Retail symbologies plus QR: a QR code is scanned (and explained) instead of being silently ignored. */
export const SCAN_BARCODE_TYPES = ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'qr'] as const;

export const MISREAD_NOTICE = 'Could not read it. Hold steady or type the digits';
export const NOT_FOOD_QR_NOTICE = 'That QR code is not a food barcode';
export const NOT_FOOD_CODE_NOTICE = 'That code is not a food barcode';

export type ScanOutcome =
  /** A product number with a valid check digit: look it up. */
  | { kind: 'gtin'; gtin14: string; display: string }
  /** A retail barcode whose check digit does not match: almost always a misread frame, keep scanning. */
  | { kind: 'misread'; notice: string }
  /** A code that holds no product number (a link, a Wi-Fi QR, a shipping label): say so, keep scanning. */
  | { kind: 'notFood'; notice: string };

/** GS1 Digital Link, the QR code printed on some packaging: https://example.com/01/09506000134352?... */
const DIGITAL_LINK = /^https?:\/\/[^\s?#]+?\/01\/(\d{14})(?=[/?#]|$)/i;
/** GS1-128: application identifier 01 (the product number, 14 digits) first, other identifiers may follow. */
const GS1_128 = /^\(?01\)?(\d{14})/;

function gtinOutcome(digits: string, display: string): ScanOutcome | null {
  const check = validateBarcode(digits);
  return check.ok ? { kind: 'gtin', gtin14: check.gtin14, display } : null;
}

/**
 * Decides what to do with one detected code. `type` is the symbology reported by the camera (`ean13`, `upc_e`,
 * `qr` ...), `data` its content.
 *
 *  - EAN-13/8, UPC-A/E: valid check digit -> `gtin`; otherwise `misread` (UPC-E is expanded to UPC-A first).
 *  - Code 128: only a valid product number (plain, or GS1-128 starting with identifier 01) counts; anything else is
 *    `notFood`, because Code 128 is mostly used on non-food labels.
 *  - QR: a plain product number or a GS1 Digital Link counts; anything else is `notFood`.
 */
export function classifyScan(type: string, data: string): ScanOutcome {
  const kind = type.trim().toLowerCase();
  const text = data.trim();

  if (kind === 'qr') {
    const link = DIGITAL_LINK.exec(text)?.[1];
    const found =
      (/^\d+$/.test(text) ? gtinOutcome(text, text) : null) ??
      (link ? gtinOutcome(link, displayGtin(link)) : null);
    return found ?? { kind: 'notFood', notice: NOT_FOOD_QR_NOTICE };
  }

  if (kind === 'code128') {
    const gs1 = GS1_128.exec(text)?.[1];
    const found =
      (/^\d+$/.test(text) ? gtinOutcome(text, text) : null) ??
      (gs1 ? gtinOutcome(gs1, displayGtin(gs1)) : null);
    return found ?? { kind: 'notFood', notice: NOT_FOOD_CODE_NOTICE };
  }

  const raw = kind === 'upc_e' ? (expandUpcE(text) ?? text) : text;
  return gtinOutcome(raw, gtinDigits(text)) ?? { kind: 'misread', notice: MISREAD_NOTICE };
}
