import { describe, expect, it } from 'vitest';
import {
  MAX_NAME_LENGTH,
  cleanCategory,
  cleanName,
  qualityCheck,
} from './quality';
import {
  buildFdcPortion,
  finalizePortions,
  formatAmount,
  portionFromLabel,
  splitQuantity,
  type FdcPortionRow,
  type PortionCandidate,
} from './portions';

describe('cleanName', () => {
  it('trims and collapses whitespace incl. NBSP, tabs and newlines', () => {
    expect(cleanName('  Apples,\u00a0 raw,\twith\nskin  ')).toBe('Apples, raw, with skin');
  });
  it('removes control and zero-width characters', () => {
    expect(cleanName('Mi\u200Blk\u0007, whole\uFEFF')).toBe('Milk, whole');
  });
  it('strips leading/trailing separators', () => {
    expect(cleanName(', Butter, salted,; ')).toBe('Butter, salted');
  });
  it('normalises unicode to NFC', () => {
    expect(cleanName('Cafe\u0301')).toBe('Café');
  });
  it('returns empty for blank / missing names', () => {
    expect(cleanName('   ')).toBe('');
    expect(cleanName(null)).toBe('');
    expect(cleanName(undefined)).toBe('');
  });
  it('caps the length at a word boundary', () => {
    const long = 'word '.repeat(100);
    const out = cleanName(long);
    expect(out.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    expect(out.endsWith('word')).toBe(true);
  });
  it('cleans categories to null when empty', () => {
    expect(cleanCategory('  Dairy   and Egg Products ')).toBe('Dairy and Egg Products');
    expect(cleanCategory('  ')).toBeNull();
    expect(cleanCategory(null)).toBeNull();
  });
});

describe('qualityCheck', () => {
  it('accepts a normal food', () => {
    expect(qualityCheck({ ENERGY_KCAL: 52, PROTEIN_G: 0.3, FAT_G: 0.2, CARBS_G: 13.8 })).toBeNull();
  });
  it('accepts pure fat / sugar / water', () => {
    expect(qualityCheck({ ENERGY_KCAL: 884, FAT_G: 100 })).toBeNull();
    expect(qualityCheck({ ENERGY_KCAL: 387, CARBS_G: 100 })).toBeNull();
    expect(qualityCheck({ ENERGY_KCAL: 0 })).toBeNull();
  });
  it('tolerates rounding noise in the macro sum', () => {
    expect(qualityCheck({ ENERGY_KCAL: 560, PROTEIN_G: 25, FAT_G: 45, CARBS_G: 32 })).toBeNull(); // 102
  });
  it('drops foods without energy', () => {
    expect(qualityCheck({ PROTEIN_G: 5 })).toBe('no_energy');
    expect(qualityCheck({})).toBe('no_energy');
  });
  it('drops impossible macros', () => {
    expect(qualityCheck({ ENERGY_KCAL: 900, PROTEIN_G: 30, FAT_G: 95, CARBS_G: 40 })).toBe('impossible_macros');
    expect(qualityCheck({ ENERGY_KCAL: 100, FAT_G: 150 })).toBe('impossible_macros');
  });
  it('drops impossible energy', () => {
    expect(qualityCheck({ ENERGY_KCAL: 5000, FAT_G: 50 })).toBe('impossible_energy');
  });
});

describe('quantities', () => {
  it('formats amounts without trailing zeros', () => {
    expect(formatAmount(1)).toBe('1');
    expect(formatAmount(0.25)).toBe('0.25');
    expect(formatAmount(2.5)).toBe('2.5');
    expect(formatAmount(0.33333)).toBe('0.333');
  });
  it('splits leading quantities', () => {
    expect(splitQuantity('1 cup')).toEqual({ amount: 1, rest: 'cup' });
    expect(splitQuantity('1/2 cup, sliced')).toEqual({ amount: 0.5, rest: 'cup, sliced' });
    expect(splitQuantity('1 1/2 cups')).toEqual({ amount: 1.5, rest: 'cups' });
    expect(splitQuantity('2.5 oz')).toEqual({ amount: 2.5, rest: 'oz' });
    expect(splitQuantity('250 mL')).toEqual({ amount: 250, rest: 'mL' });
    expect(splitQuantity('medium')).toEqual({ amount: null, rest: 'medium' });
    expect(splitQuantity('1/0 cup').amount).toBeNull();
  });
  it('builds portions from free-text labels and skips placeholders', () => {
    expect(portionFromLabel('1 cup (250 mL)', 240)).toMatchObject({ label: '1 cup (250 mL)', amount: 1, unit: 'cup (250 mL)', grams: 240 });
    expect(portionFromLabel('No serving size specified', 100)).toBeNull();
    expect(portionFromLabel('   ', 100)).toBeNull();
  });
});

const row = (over: Partial<FdcPortionRow>): FdcPortionRow => ({
  seq: 1,
  amount: 1,
  unitName: '',
  description: '',
  modifier: '',
  grams: 100,
  ...over,
});

describe('buildFdcPortion labels', () => {
  it('amount + unit + modifier: "1 cup, chopped"', () => {
    expect(buildFdcPortion(row({ unitName: 'cup', modifier: 'chopped', grams: 125 }))).toEqual({
      seq: 1,
      label: '1 cup, chopped',
      amount: 1,
      unit: 'cup',
      grams: 125,
    });
  });
  it('amount + unit without modifier', () => {
    expect(buildFdcPortion(row({ unitName: 'tablespoon', amount: 2, grams: 28 }))?.label).toBe('2 tablespoon');
  });
  it('ignores the unit "undetermined" and uses the modifier: "1 large"', () => {
    const p = buildFdcPortion(row({ unitName: 'undetermined', modifier: 'large', grams: 50 }));
    expect(p).toMatchObject({ label: '1 large', amount: 1, unit: 'large' });
  });
  it('uses portion_description when there is no unit (FNDDS)', () => {
    const p = buildFdcPortion(row({ unitName: 'undetermined', description: '1 cup', modifier: '10205', grams: 244 }));
    expect(p).toMatchObject({ label: '1 cup', amount: 1, unit: 'cup', grams: 244 });
  });
  it('prefixes the amount when a description has none', () => {
    expect(buildFdcPortion(row({ description: 'medium', amount: 1, grams: 182 }))?.label).toBe('1 medium');
  });
  it('ignores numeric modifier codes', () => {
    expect(buildFdcPortion(row({ unitName: 'cup', modifier: '10205', grams: 240 }))?.label).toBe('1 cup');
  });
  it('relabels the regulatory RACC unit as a reference serving', () => {
    expect(buildFdcPortion(row({ unitName: 'RACC', grams: 30 }))).toMatchObject({
      label: '1 serving (RACC)',
      unit: 'serving (RACC)',
      grams: 30,
    });
  });
  it('uses portion_description as the qualifier of a real unit (Foundation: cup + "shredded")', () => {
    expect(buildFdcPortion(row({ unitName: 'cup', description: 'shredded', grams: 105 }))?.label).toBe('1 cup, shredded');
    expect(buildFdcPortion(row({ unitName: 'cup', description: '1 cup', grams: 105 }))?.label).toBe('1 cup'); // redundant label
    expect(buildFdcPortion(row({ unitName: 'cup', modifier: 'chopped', description: 'shredded', grams: 105 }))?.label).toBe('1 cup, chopped');
  });
  it('treats a missing amount as 1', () => {
    expect(buildFdcPortion(row({ unitName: 'slice', amount: null, grams: 30 }))).toMatchObject({ label: '1 slice', amount: 1 });
  });
  it('drops placeholders and rows without a label', () => {
    expect(buildFdcPortion(row({ description: 'Quantity not specified' }))).toBeNull();
    expect(buildFdcPortion(row({ description: 'Guideline amount per fl oz of beverage' }))).toBeNull();
    expect(buildFdcPortion(row({ unitName: 'undetermined', modifier: '10205' }))).toBeNull();
  });
  it('drops grams <= 0 and missing grams', () => {
    expect(buildFdcPortion(row({ unitName: 'cup', grams: 0 }))).toBeNull();
    expect(buildFdcPortion(row({ unitName: 'cup', grams: -3 }))).toBeNull();
    expect(buildFdcPortion(row({ unitName: 'cup', grams: null }))).toBeNull();
  });
});

describe('finalizePortions', () => {
  const cand = (label: string, grams: number, seq: number | null): PortionCandidate => ({
    seq,
    label,
    amount: 1,
    unit: 'x',
    grams,
  });

  it('orders by seq, numbers sort_order and always appends 100 g', () => {
    const { portions } = finalizePortions([cand('b', 20, 2), cand('a', 10, 1), cand('z', 30, null)]);
    expect(portions.map((p) => [p.label, p.sortOrder])).toEqual([
      ['a', 0],
      ['b', 1],
      ['z', 2],
      ['100 g', 3],
    ]);
    expect(portions.at(-1)).toMatchObject({ amount: 100, unit: 'g', grams: 100 });
  });

  it('creates only the 100 g portion for a food without portions', () => {
    expect(finalizePortions([]).portions).toEqual([
      { label: '100 g', amount: 100, unit: 'g', grams: 100, sortOrder: 0 },
    ]);
  });

  it('does not duplicate an existing 100 g portion', () => {
    const { portions } = finalizePortions([cand('100 g', 100, 1)]);
    expect(portions.filter((p) => p.label.toLowerCase() === '100 g')).toHaveLength(1);
  });

  it('rejects a "100 g" portion that does not weigh 100 g and still adds the real one', () => {
    const { portions } = finalizePortions([cand('100 g', 1, 1)]);
    expect(portions.map((p) => [p.label, p.grams])).toEqual([['100 g', 100]]);
  });

  it('drops grams <= 0, absurd grams and case-insensitive duplicate labels', () => {
    const { portions, dropped } = finalizePortions([
      cand('1 cup', 240, 1),
      cand('1 CUP', 250, 2),
      cand('bad', 0, 3),
      cand('huge', 99999, 4),
      cand('tiny', 0.004, 5),
    ]);
    expect(portions.map((p) => p.label)).toEqual(['1 cup', '100 g']);
    expect(dropped).toBe(4);
  });

  it('rounds grams to 2 decimals and caps the number of portions', () => {
    const many = Array.from({ length: 40 }, (_, i) => cand(`p${i}`, 10.123, i));
    const { portions } = finalizePortions(many);
    expect(portions[0]?.grams).toBe(10.12);
    expect(portions.length).toBe(21); // 20 + 100 g
  });
});
