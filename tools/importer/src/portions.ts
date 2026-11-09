/** Portion (serving size) building shared by the FDC and CNF loaders. */
import type { ImportPortion } from './types';

/** A portion before ordering / de-duplication. */
export interface PortionCandidate {
  /** Source ordering hint (FDC seq_num); null sorts last. */
  seq: number | null;
  label: string;
  amount: number | null;
  unit: string | null;
  grams: number;
}

export const MAX_PORTIONS_PER_FOOD = 20;
export const MAX_PORTION_GRAMS = 20000;
export const MAX_LABEL_LENGTH = 120;

/** `1`, `0.25`, `2.5` (max 3 decimals, no trailing zeros). */
export function formatAmount(n: number): string {
  return String(Number(n.toFixed(3)));
}

const FRACTION = /^(\d+)\s*\/\s*(\d+)$/;

/** Parses `1`, `0.5`, `1/2`, `1 1/2`. Null when not a positive quantity. */
function parseQuantityToken(token: string): number | null {
  const t = token.trim();
  const mixed = /^(\d+)\s+(\d+)\s*\/\s*(\d+)$/.exec(t);
  if (mixed) {
    const den = Number(mixed[3]);
    return den === 0 ? null : Number(mixed[1]) + Number(mixed[2]) / den;
  }
  const frac = FRACTION.exec(t);
  if (frac) {
    const den = Number(frac[2]);
    return den === 0 ? null : Number(frac[1]) / den;
  }
  if (/^\d+(\.\d+)?$/.test(t)) {
    const n = Number(t);
    return n > 0 ? n : null;
  }
  return null;
}

/** Splits `"1 cup, chopped"` into `{ amount: 1, rest: "cup, chopped" }`; amount null if no leading quantity. */
export function splitQuantity(label: string): { amount: number | null; rest: string } {
  const m = /^(\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d+(?:\.\d+)?)\s*(.*)$/.exec(label.trim());
  if (!m) return { amount: null, rest: label.trim() };
  const amount = parseQuantityToken(m[1] ?? '');
  if (amount === null) return { amount: null, rest: label.trim() };
  return { amount, rest: (m[2] ?? '').trim() };
}

/** Portion from a free-text serving label such as `"1 cup (250 mL)"` or `"1 slice"`. */
export function portionFromLabel(
  rawLabel: string,
  grams: number,
  seq: number | null = null,
): PortionCandidate | null {
  const label = rawLabel.replace(/\s+/g, ' ').trim();
  if (label === '' || NOISE_LABEL.test(label)) return null;
  const { amount, rest } = splitQuantity(label);
  const unit = amount !== null && rest !== '' && rest.length <= 40 ? rest : null;
  return { seq, label, amount, unit, grams };
}

const NOISE_LABEL =
  /^(quantity not specified|guideline amount|not specified|no serving size|undetermined|n\/a)/i;

/**
 * FDC measure units that read badly as a label. RACC = "Reference Amount
 * Customarily Consumed", the regulatory reference serving of Foundation Foods.
 */
const UNIT_DISPLAY: Record<string, string> = { racc: 'serving (RACC)' };

function isNumericCode(s: string): boolean {
  return /^\d+(\.\d+)?$/.test(s.trim());
}

/** One row of FDC `food_portion.csv` with the measure unit already resolved. */
export interface FdcPortionRow {
  seq: number | null;
  amount: number | null;
  /** measure_unit.name, '' when none. 'undetermined' is treated as none. */
  unitName: string;
  description: string;
  modifier: string;
  grams: number | null;
}

/**
 * Builds the portion label like USDA's own displays:
 *  - real unit:        `"1 cup, chopped"`           (amount + unit + modifier)
 *  - description only: `"1 slice"` (FNDDS portion_description) / `"1 large"` (modifier)
 * Numeric modifiers (FNDDS portion codes) and "Quantity not specified" style
 * rows are ignored.
 */
export function buildFdcPortion(row: FdcPortionRow): PortionCandidate | null {
  if (row.grams === null || !(row.grams > 0)) return null;

  const unitName = row.unitName.trim().toLowerCase();
  const unit = unitName === '' || unitName === 'undetermined' ? null : unitName;
  const modifier = isNumericCode(row.modifier) ? '' : row.modifier.replace(/\s+/g, ' ').trim();
  const description = row.description.replace(/\s+/g, ' ').trim();
  if (NOISE_LABEL.test(description) || NOISE_LABEL.test(modifier)) return null;
  const amount = row.amount !== null && row.amount > 0 ? row.amount : null;

  if (unit !== null) {
    const qty = amount ?? 1;
    const displayUnit = UNIT_DISPLAY[unit] ?? unit;
    // Foundation JSON puts the qualifier in portionDescription ("shredded"); a description that
    // is itself a full label ("1 cup") is redundant next to a real unit.
    const qualifier = modifier !== '' ? modifier : /^\d/.test(description) ? '' : description;
    const label = `${formatAmount(qty)} ${displayUnit}${qualifier !== '' ? `, ${qualifier}` : ''}`;
    return { seq: row.seq, label, amount: qty, unit: displayUnit, grams: row.grams };
  }

  if (description !== '') {
    let label = description;
    if (!/^\d/.test(label) && amount !== null) label = `${formatAmount(amount)} ${label}`;
    if (modifier !== '' && !label.toLowerCase().includes(modifier.toLowerCase())) {
      label = `${label}, ${modifier}`;
    }
    return portionFromLabel(label, row.grams, row.seq);
  }

  if (modifier !== '') {
    const qty = amount ?? 1;
    const modifierUnit = modifier.length <= 40 ? modifier : null;
    return {
      seq: row.seq,
      label: `${formatAmount(qty)} ${modifier}`,
      amount: qty,
      unit: modifierUnit,
      grams: row.grams,
    };
  }
  return null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export const HUNDRED_GRAMS_LABEL = '100 g';

/**
 * Orders (by seq, then input order), validates, de-duplicates (case-insensitive
 * label), caps and numbers the candidates and always appends a `100 g` portion.
 * Returns the portions and how many candidates were dropped.
 */
export function finalizePortions(candidates: readonly PortionCandidate[]): {
  portions: ImportPortion[];
  dropped: number;
} {
  const indexed = candidates.map((c, i) => ({ c, i }));
  indexed.sort((a, b) => {
    const sa = a.c.seq ?? Number.MAX_SAFE_INTEGER;
    const sb = b.c.seq ?? Number.MAX_SAFE_INTEGER;
    return sa - sb || a.i - b.i;
  });

  const seen = new Set<string>();
  const portions: ImportPortion[] = [];
  let dropped = 0;
  for (const { c } of indexed) {
    const grams = round2(c.grams);
    const label = c.label.length > MAX_LABEL_LENGTH ? c.label.slice(0, MAX_LABEL_LENGTH).trim() : c.label;
    const key = label.toLowerCase();
    // A "100 g" portion that does not weigh 100 g is a mis-read source row.
    const inconsistent = key === HUNDRED_GRAMS_LABEL && grams !== 100;
    if (!(grams > 0) || grams > MAX_PORTION_GRAMS || label === '' || inconsistent || seen.has(key)) {
      dropped += 1;
      continue;
    }
    if (portions.length >= MAX_PORTIONS_PER_FOOD) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    portions.push({
      label,
      amount: c.amount !== null ? Number(c.amount.toFixed(3)) : null,
      unit: c.unit,
      grams,
      sortOrder: portions.length,
    });
  }

  if (!seen.has(HUNDRED_GRAMS_LABEL)) {
    portions.push({
      label: HUNDRED_GRAMS_LABEL,
      amount: 100,
      unit: 'g',
      grams: 100,
      sortOrder: portions.length,
    });
  }
  return { portions, dropped };
}
