import { mlToFlOz, type UnitSystem } from '@cal/core';

import { fromISODate, todayISO } from '@/state/selected-date';

/** Rounds to `dp` decimals and drops trailing zeros ("2", "2.5"). */
export function trimNum(value: number, dp = 1): string {
  const r = Number(value.toFixed(dp));
  return String(Object.is(r, -0) ? 0 : r);
}

/** "Tuesday, November 10" (+ " (today)"). */
export function formatDateLabel(iso: string): string {
  const label = fromISODate(iso).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  return iso === todayISO() ? `${label} (today)` : label;
}

/** Short date for context lines: "Nov 3". */
export function formatShortDate(iso: string): string {
  return fromISODate(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Water/drink volume in the user's units: "250 mL", "1.25 L" or "8.5 fl oz". */
export function formatVolume(ml: number, system: UnitSystem): string {
  if (system === 'imperial') return `${trimNum(mlToFlOz(ml), 1)} fl oz`;
  return ml >= 1000 ? `${trimNum(ml / 1000, 2)} L` : `${Math.round(ml)} mL`;
}
