/** Food name hygiene and quality filters. */
import type { NutrientMap } from '@cal/core';
import type { DropReason } from './types';

/** Longest name kept (search columns are generated from it). */
export const MAX_NAME_LENGTH = 250;

/** protein + fat + carbs above this (g per 100 g) is impossible (10 % tolerance for rounding/fibre). */
export const MACRO_SUM_MAX_G = 110;
/** Any single macro above this (g per 100 g) is impossible. */
export const SINGLE_MACRO_MAX_G = 101;
/** Pure fat is ~900 kcal / 100 g; anything above this is a data error. */
export const ENERGY_MAX_KCAL = 1000;

/** Categories that are not food (case-insensitive). */
export const EXCLUDED_CATEGORIES: ReadonlySet<string> = new Set(['quality control materials']);

/**
 * Trims, collapses whitespace (incl. NBSP / tabs / newlines), removes control
 * and zero-width characters, strips trailing separators and caps the length.
 * Returns '' for unusable names.
 */
export function cleanName(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  let s = raw
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^[\s,;:]+|[\s,;:]+$/g, '').trim();
  if (s.length > MAX_NAME_LENGTH) s = s.slice(0, MAX_NAME_LENGTH).replace(/\s+\S*$/, '').trim();
  return s;
}

/** Cleans a category label; null when empty. */
export function cleanCategory(raw: string | null | undefined): string | null {
  const s = cleanName(raw);
  return s === '' ? null : s;
}

/**
 * Plausibility filter on the resolved per-100 g nutrients.
 * Returns the reason to drop the food, or null when it is acceptable.
 */
export function qualityCheck(nutrients: NutrientMap): DropReason | null {
  const energy = nutrients.ENERGY_KCAL;
  if (energy === undefined) return 'no_energy';

  const macros = [nutrients.PROTEIN_G, nutrients.FAT_G, nutrients.CARBS_G].filter(
    (v): v is number => v !== undefined,
  );
  const sum = macros.reduce((a, b) => a + b, 0);
  if (sum > MACRO_SUM_MAX_G || macros.some((v) => v > SINGLE_MACRO_MAX_G)) {
    return 'impossible_macros';
  }
  if (energy > ENERGY_MAX_KCAL) return 'impossible_energy';
  return null;
}
