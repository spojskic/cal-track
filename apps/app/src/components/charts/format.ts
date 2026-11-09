/** Number/label formatting shared by the diary and dashboard (locale independent, Hermes safe). */

/** "1,234.5"; "-" for undefined/NaN. `trim` drops trailing zeros after rounding. */
export function formatNumber(n: number | null | undefined, decimals = 0, trim = false): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-';
  const fixed = Math.abs(n).toFixed(decimals);
  const [intPart = '0', frac] = fixed.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let out = frac ? `${grouped}.${frac}` : grouped;
  if (trim && out.includes('.')) out = out.replace(/\.?0+$/, '');
  return n < 0 && Number(fixed) !== 0 ? `-${out}` : out;
}

/** Sensible decimals for a nutrient amount in its catalog unit. */
export function nutrientDecimals(unit: string, value: number | undefined): number {
  const v = Math.abs(value ?? 0);
  switch (unit) {
    case 'kcal':
    case 'iu':
    case 'ml':
      return 0;
    case 'g':
      return v >= 100 ? 0 : 1;
    case 'mg':
      return v >= 100 ? 0 : v >= 10 ? 1 : 2;
    case 'ug':
      return v >= 100 ? 0 : 1;
    default:
      return 1;
  }
}

/** "175.6 g", "12 mg", "-" when unknown. */
export function formatAmount(value: number | undefined, unit: string): string {
  if (value === undefined) return '-';
  return `${formatNumber(value, nutrientDecimals(unit, value), true)} ${unit === 'ug' ? 'µg' : unit}`;
}

export function formatPercent(fraction: number | undefined): string {
  if (fraction === undefined || !Number.isFinite(fraction)) return '-';
  return `${Math.round(fraction * 100)}%`;
}
