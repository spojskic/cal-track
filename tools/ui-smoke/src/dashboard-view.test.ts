/**
 * The numbers and texts of the desktop dashboard and diary panels as plain data (apps/app/src/components/diary/dashboard-view.ts):
 * the aligned bar rows of the targets, the KPI cells (consumed, remaining, protein / carbs / fat), the streak line, the weight figures
 * and the line above the entry list. Pure Node: no React Native is imported.
 */
import { describe, expect, it } from 'vitest';

// The module imports other app modules through the `@/` alias, which vitest resolves but this folder's tsconfig does not: load it
// at run time (same as diary-ui.test.ts).
const load = (specifier: string): Promise<any> => import(/* @vite-ignore */ specifier);
const { averageBarRows, changeSign, entriesMeta, macroBarRows, macroKpi, remainingKpi, streakMessage, weightStats } = await load(
  '@/components/diary/dashboard-view',
);

/** The part of components/diary/targets-view.ts MacroRow these tests use. */
interface MacroRow {
  key: 'energy' | 'protein' | 'carbs' | 'fat';
  label: string;
  unit: string;
  value: number | undefined;
  target: number | undefined;
  color: string;
  overIsBad: boolean;
  decimals: number;
}

const COLORS = { danger: '#c00', success: '#0a0' };

const row = (over: Partial<MacroRow> = {}): MacroRow => ({
  key: 'protein',
  label: 'Protein',
  unit: 'g',
  value: 75,
  target: 150,
  color: '#6a6',
  overIsBad: false,
  decimals: 1,
  ...over,
});

describe('macroBarRows', () => {
  it('value, percentage and a half-filled bar, with the accessible name of the phone bars', () => {
    const [r] = macroBarRows([row()], COLORS);
    expect(r).toMatchObject({
      key: 'protein',
      label: 'Protein',
      valueText: '75 / 150 g',
      pctText: '50%',
      tone: 'muted',
      color: '#6a6',
      fill: 0.5,
      overFill: 0,
      markAt: undefined,
      now: 50,
      accessibilityLabel: 'Protein: 75 / 150 g, 50%',
    });
  });

  it('a limit that is passed is drawn rescaled with a notch at the target and the danger colour', () => {
    const [r] = macroBarRows([row({ key: 'energy', label: 'Energy', unit: 'kcal', value: 2400, target: 2000, decimals: 0, overIsBad: true })], COLORS);
    expect(r?.pctText).toBe('120%');
    expect(r?.tone).toBe('danger');
    expect(r?.overColor).toBe(COLORS.danger);
    expect(r?.fill).toBeCloseTo(1 / 1.2, 6);
    expect(r?.overFill).toBeCloseTo(0.2 / 1.2, 6);
    expect(r?.markAt).toBeCloseTo(1 / 1.2, 6);
    expect(r?.now).toBe(100);
  });

  it('a goal that is reached is success, and past it uses the success colour for the overflow', () => {
    const [r] = macroBarRows([row({ value: 180 })], COLORS);
    expect(r?.tone).toBe('success');
    expect(r?.overColor).toBe(COLORS.success);
    expect(r?.pctText).toBe('120%');
  });

  it('without a target there is only the amount and an empty bar', () => {
    const [r] = macroBarRows([row({ target: undefined, value: 120 })], COLORS);
    expect(r).toMatchObject({ valueText: '120 g', pctText: '', fill: 0, tone: 'muted', now: undefined, accessibilityLabel: 'Protein: 120 g' });
  });

  it('the energy bar is driven by the amount eaten and the target it is given', () => {
    const [r] = macroBarRows([row({ key: 'energy', label: 'Energy', unit: 'kcal', value: 1500, target: 2000, decimals: 0, overIsBad: true })], COLORS);
    expect(r?.valueText).toBe('1,500 / 2,000 kcal');
    expect(r?.pctText).toBe('75%');
  });

  it('keeps the order of the rows', () => {
    const rows = macroBarRows(
      [row({ key: 'energy' }), row({ key: 'protein' }), row({ key: 'carbs' }), row({ key: 'fat' })],
      COLORS,
    );
    expect(rows.map((r: { key: string }) => r.key)).toEqual(['energy', 'protein', 'carbs', 'fat']);
  });
});

describe('averageBarRows', () => {
  it('the bar is the share of the calories, the value the grams', () => {
    const rows = averageBarRows(
      [
        { key: 'protein', label: 'Protein', g: 112.46, pct: 24.4, color: 'p' },
        { key: 'carbs', label: 'Carbs', g: 230, pct: 50, color: 'c' },
        { key: 'fat', label: 'Fat', g: 70.04, pct: 25.6, color: 'f' },
      ],
      COLORS,
    );
    expect(rows[0]).toMatchObject({
      valueText: '112.5 g',
      pctText: '24%',
      fill: 0.244,
      accessibilityLabel: 'Protein 112.5 grams, 24 percent of calories',
      markAt: undefined,
    });
    expect(rows[1]).toMatchObject({ valueText: '230 g', pctText: '50%', fill: 0.5 });
    expect(rows[2]).toMatchObject({ valueText: '70 g', pctText: '26%' });
  });

  it('a share outside 0..100 or not a number cannot overflow the track', () => {
    const rows = averageBarRows(
      [
        { key: 'a', label: 'A', g: 1, pct: 140, color: 'x' },
        { key: 'b', label: 'B', g: 1, pct: -5, color: 'x' },
        { key: 'c', label: 'C', g: 1, pct: Number.NaN, color: 'x' },
      ],
      COLORS,
    );
    expect(rows.map((r: { fill: number }) => r.fill)).toEqual([1, 0, 0]);
  });
});

describe('macroKpi', () => {
  it('the amount big (no decimals), "of <target> - <percent>" under it, a progress share', () => {
    const k = macroKpi(row({ value: 82.4 }), COLORS);
    expect(k).toMatchObject({ label: 'Protein', value: '82', unit: 'g', delta: 'of 150 g - 55%', deltaTone: 'muted', color: '#6a6', overColor: COLORS.success });
    expect(k.fraction).toBeCloseTo(82.4 / 150, 6);
    expect(k.progressLabel).toBe('Protein: 82.4 / 150 g, 55%');
  });

  it('goal reached: success; limit passed: danger', () => {
    expect(macroKpi(row({ value: 150 }), COLORS).deltaTone).toBe('success');
    const energy = macroKpi(row({ key: 'energy', label: 'Energy', unit: 'kcal', value: 2400, target: 2000, decimals: 0, overIsBad: true }), COLORS);
    expect(energy).toMatchObject({ value: '2,400', delta: 'of 2,000 kcal - 120%', deltaTone: 'danger', overColor: COLORS.danger });
  });

  it('no target: no delta and no progress; an unknown amount reads "-"', () => {
    expect(macroKpi(row({ target: undefined }), COLORS)).toMatchObject({ delta: undefined, fraction: undefined, value: '75' });
    expect(macroKpi(row({ value: undefined }), COLORS)).toMatchObject({ value: '-', fraction: undefined });
  });
});

describe('remainingKpi', () => {
  it('Target view: what is left of the budget', () => {
    const k = remainingKpi({ remaining: 500, mode: 'target', consumed: 2000, budget: 2500, expenditure: 2700 });
    expect(k).toEqual({ label: 'Remaining', value: '500', unit: 'kcal', delta: 'of 2,500 kcal budget', deltaTone: 'muted', fraction: 0.8, negative: false });
  });

  it('Target view: over the budget is "Over" in the danger tone with the amount absolute', () => {
    const k = remainingKpi({ remaining: -120, mode: 'target', consumed: 2620, budget: 2500, expenditure: undefined });
    expect(k).toMatchObject({ label: 'Over', value: '120', deltaTone: 'danger', negative: true });
    expect(k.fraction).toBeCloseTo(2620 / 2500, 6);
  });

  it('Balance view: Deficit / Surplus against what was burned', () => {
    const deficit = remainingKpi({ remaining: 300, mode: 'balance', consumed: 2400, budget: 2500, expenditure: 2700 });
    expect(deficit).toMatchObject({ label: 'Deficit', value: '300', delta: 'burned 2,700 kcal', deltaTone: 'muted', negative: false });
    expect(deficit.fraction).toBeCloseTo(2400 / 2700, 6);
    const surplus = remainingKpi({ remaining: -50, mode: 'balance', consumed: 2750, budget: 2500, expenditure: 2700 });
    expect(surplus).toMatchObject({ label: 'Surplus', value: '50', deltaTone: 'muted', negative: true });
  });

  it('before targets resolve the value is "-" and nothing is claimed', () => {
    expect(remainingKpi({ remaining: undefined, mode: 'target', consumed: 0, budget: undefined, expenditure: undefined })).toEqual({
      label: 'Remaining',
      value: '-',
      unit: 'kcal',
      delta: undefined,
      deltaTone: 'muted',
      fraction: undefined,
      negative: false,
    });
    expect(remainingKpi({ remaining: undefined, mode: 'balance', consumed: 0, budget: undefined, expenditure: undefined }).label).toBe('Balance');
  });
});

describe('streakMessage', () => {
  it('says what to do next', () => {
    expect(streakMessage(0, false)).toBe('Log something today to start a streak.');
    expect(streakMessage(0, true)).toBe('Log something today to start a streak.');
    expect(streakMessage(4, true)).toBe('Logged today. Nice work.');
    expect(streakMessage(4, false)).toBe('Log something today to keep it going.');
    expect(streakMessage(4, true, true)).toBe('');
  });
});

describe('weightStats / changeSign', () => {
  it('latest, first, change, lowest and highest', () => {
    const stats = weightStats([
      { date: '2026-10-12', kg: 82 },
      { date: '2026-10-20', kg: 81.2 },
      { date: '2026-11-01', kg: 82.4 },
      { date: '2026-11-09', kg: 80.6 },
    ]);
    expect(stats).toMatchObject({ count: 4, latestKg: 80.6, firstKg: 82, lowestKg: 80.6, highestKg: 82.4, latestDate: '2026-11-09' });
    expect(stats.changeKg).toBeCloseTo(-1.4, 6);
  });

  it('one weigh-in has no change; none has nothing', () => {
    expect(weightStats([{ date: '2026-11-09', kg: 80 }])).toMatchObject({ count: 1, latestKg: 80, changeKg: undefined, lowestKg: 80, highestKg: 80 });
    expect(weightStats([])).toEqual({
      count: 0,
      latestKg: undefined,
      firstKg: undefined,
      changeKg: undefined,
      lowestKg: undefined,
      highestKg: undefined,
      latestDate: undefined,
    });
  });

  it('the sign: nothing below 50 g (it reads as zero)', () => {
    expect(changeSign(undefined)).toBe('');
    expect(changeSign(0.04)).toBe('');
    expect(changeSign(-0.04)).toBe('');
    expect(changeSign(0.05)).toBe('+');
    expect(changeSign(-1.4)).toBe('-');
  });
});

describe('entriesMeta', () => {
  it('"6 items, 2,376 kcal"', () => {
    expect(entriesMeta(6, 2376.4)).toBe('6 items, 2,376 kcal');
    expect(entriesMeta(1, 250)).toBe('1 item, 250 kcal');
    expect(entriesMeta(0, 0)).toBe('0 items, 0 kcal');
  });
});
