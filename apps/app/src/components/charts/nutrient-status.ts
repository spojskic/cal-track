// Pure target/intake semantics shared by the nutrient bars, rings and tables.

export type NutrientStatus = 'unknown' | 'none' | 'under' | 'ok' | 'over';

/**
 * Where an intake sits relative to its target:
 * below min => 'under' (neutral grey), within [min, max] => 'ok' (success), above max => 'over' (danger).
 * 'none' = no target, 'unknown' = no intake data.
 */
export function nutrientStatus(amount: number | undefined, min?: number, max?: number): NutrientStatus {
  const hasMin = typeof min === 'number' && min > 0;
  const hasMax = typeof max === 'number' && max > 0;
  if (!hasMin && !hasMax) return amount === undefined ? 'unknown' : 'none';
  if (amount === undefined) return 'unknown';
  if (hasMax && amount > (max as number)) return 'over';
  if (hasMin && amount < (min as number)) return 'under';
  return 'ok';
}

/** Fraction of the reference target (min, or max for limit-only nutrients). */
export function nutrientFraction(amount: number | undefined, min?: number, max?: number): number | undefined {
  const ref = typeof min === 'number' && min > 0 ? min : typeof max === 'number' && max > 0 ? max : undefined;
  if (ref === undefined || amount === undefined) return undefined;
  return Math.max(0, amount) / ref;
}
