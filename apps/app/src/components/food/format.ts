import type { NutrientUnit } from '@cal/core';

import { addDays, fromISODate, todayISO } from '@/state/selected-date';

export const UNIT_LABEL: Record<NutrientUnit, string> = {
  kcal: 'kcal',
  g: 'g',
  mg: 'mg',
  ug: '\u00B5g',
  iu: 'IU',
  ml: 'ml',
};

/** Rounds to 2 decimals and drops trailing zeros ("12", "0.5"). */
export function trimNumber(value: number, decimals = 2): string {
  const rounded = Number(value.toFixed(decimals));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/**
 * Nutrient amount for display. Unknown (null/undefined/NaN) is "-", never 0.
 * Larger values get fewer decimals: 245, 24.5, 2.45, 0.245.
 */
export function formatAmount(value: number | null | undefined, unit: NutrientUnit, withUnit = false): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  const abs = Math.abs(value);
  let decimals = 2;
  if (unit === 'kcal' || abs >= 100) decimals = 0;
  else if (abs >= 10) decimals = 1;
  else if (abs >= 1) decimals = 2;
  else decimals = 3;
  const text = trimNumber(value, decimals);
  return withUnit ? `${text} ${UNIT_LABEL[unit]}` : text;
}

/** Whole-number kcal ("52") or "-" when unknown. */
export function formatKcal(value: number | null | undefined): string {
  return formatAmount(value, 'kcal');
}

/** "52 kcal | P 0.3 g | C 14 g | F 0.2 g" per-100 g line; unknown parts show "-". */
export function macroLine(food: {
  kcal100g: number | null;
  protein100g: number | null;
  carbs100g: number | null;
  fat100g: number | null;
}): string {
  const g = (v: number | null) => (v === null ? '-' : `${formatAmount(v, 'g')} g`);
  return `${formatKcal(food.kcal100g)} kcal  |  P ${g(food.protein100g)}  |  C ${g(food.carbs100g)}  |  F ${g(food.fat100g)}`;
}

/** "Today", "Yesterday", "Tomorrow" or "Mon, Nov 10" for a local ISO date. */
export function formatDayLabel(iso: string): string {
  const today = todayISO();
  if (iso === today) return 'Today';
  if (iso === addDays(today, -1)) return 'Yesterday';
  if (iso === addDays(today, 1)) return 'Tomorrow';
  return fromISODate(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Lower-case + accent-insensitive text for client-side filtering (handles the Balkan letters too). */
export function foldText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'd')
    .toLowerCase();
}

export function firstParam(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v === undefined || v === '' ? undefined : v;
}

/** Shows a GTIN-14 the way it is printed: drops the padding zeros down to 8, 12, 13 or 14 digits. */
export function displayGtin(gtin14: string): string {
  const stripped = gtin14.replace(/^0+/, '');
  const len = stripped.length;
  const target = len <= 8 ? 8 : len <= 12 ? 12 : len <= 13 ? 13 : 14;
  return stripped.padStart(target, '0');
}
