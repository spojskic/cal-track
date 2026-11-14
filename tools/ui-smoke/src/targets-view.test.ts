import { describe, expect, it } from 'vitest';

// The app modules are imported at run time through the `@/` alias: this package's tsconfig knows nothing about the app (React Native
// types, JSX), so a static import would not typecheck here. Same pattern as app-data-contract.test.ts.
const load = (specifier: string): Promise<any> => import(/* @vite-ignore */ specifier);

const COLORS: any = { energy: '#e', protein: '#p', carbs: '#c', fat: '#f' };
const targets: any = {
  energy: { target: 1500 },
  // Consistent with the energy target above: 131.3 g protein (525.2 kcal), fat 30 % (450 kcal = 50 g), carbs the rest.
  macros: { protein: { grams: 131.3 }, carbs: { grams: 131.2 }, fat: { grams: 50 } },
};
// A complete target resolution (the shape `buildMacroRows` needs to re-derive macros for the day budget):
// protein_per_kg 1.6 g/kg at 82.0625 kg = 131.3 g protein, fat 30 %, carbs the remainder - the static macros above.
const resolved: any = {
  ...targets,
  macroMode: { mode: 'protein_per_kg', proteinGPerKg: 1.6 },
  weightKg: 82.0625,
  bodyFatPct: null,
};

async function rows(energy: number | undefined, budgetExtraKcal: number): Promise<any[]> {
  const { buildMacroRows } = await load('@/components/diary/targets-view');
  return buildMacroRows({
    colors: COLORS,
    totals: energy === undefined ? {} : { ENERGY_KCAL: energy },
    hasEntries: energy !== undefined,
    targets,
    netCarbs: true,
    budgetExtraKcal,
  });
}

/** Loads buildMacroRows and runs it against the complete `resolved` fixture (override the fixture with an argument). */
function buildMacroRowsLoader() {
  return async (budgetExtraKcal: number, fixture: any = resolved): Promise<any[]> => {
    const { buildMacroRows } = await load('@/components/diary/targets-view');
    return buildMacroRows({
      colors: COLORS,
      totals: {},
      hasEntries: false,
      targets: fixture,
      netCarbs: true,
      budgetExtraKcal,
    });
  };
}

describe('buildMacroRows: the energy row compares what was eaten with the day budget', () => {
  it('the target of the row is the energy target plus what burning above the baseline adds', async () => {
    expect((await rows(528, 0))[0]).toMatchObject({ key: 'energy', value: 528, target: 1500 });
    expect((await rows(528, 719))[0]).toMatchObject({ value: 528, target: 2219 });
  });

  it('a day with a hard workout and a normal breakfast shows progress, not 0% (it used to be eaten minus burned over the plain target)', async () => {
    const { macroProgress } = await load('@/components/diary/macro-progress');
    const energy = (await rows(528, 719))[0];
    const p = macroProgress({ value: energy.value, target: energy.target, unit: energy.unit, decimals: 0, overIsBad: true });
    expect(p.pctText).toBe('24%');
    expect(p.valueText).toBe('528 / 2,219 kcal');
  });

  it('there is no net figure any more', async () => {
    expect((await rows(1940, 56))[0]).not.toHaveProperty('netValue');
  });

  it('without targets there is no target; the other rows are unchanged by the budget', async () => {
    const { buildMacroRows } = await load('@/components/diary/targets-view');
    const none = buildMacroRows({ colors: COLORS, totals: { ENERGY_KCAL: 100 }, hasEntries: true, targets: undefined, netCarbs: true, budgetExtraKcal: 300 });
    expect(none[0].target).toBeUndefined();
    expect((await rows(528, 719))[1]).toMatchObject({ key: 'protein', target: 131.3 });
  });

  it('a negative extra never lowers the target', async () => {
    expect((await rows(528, -50))[0].target).toBe(1500);
  });
});

describe('buildMacroRows: the macro targets scale with the day budget', () => {
  const loadRows = buildMacroRowsLoader();

  it('at zero burn the day macros equal the static plan macros', async () => {
    const [energy, protein, carbs, fat] = await loadRows(0);
    expect(energy.target).toBe(1500);
    expect(protein.target).toBeCloseTo(131.3, 1);
    expect(carbs.target).toBeCloseTo(131.2, 1);
    expect(fat.target).toBeCloseTo(50, 1);
  });

  it('protein_per_kg: protein stays anchored to the body weight, fat and carbs absorb the burn', async () => {
    // budget 1500 + 719 = 2219: protein 1.6 g/kg (131.3), fat 30 % of 2219 = 74 g, carbs the remainder (257 g).
    const [energy, protein, carbs, fat] = await loadRows(719);
    expect(energy.target).toBe(2219);
    expect(protein.target).toBeCloseTo(131.3, 1);
    expect(carbs.target).toBeCloseTo(257, 0);
    expect(fat.target).toBeCloseTo(74, 0);
  });

  it('ratios scale all three proportionally', async () => {
    const { buildMacroRows } = await load('@/components/diary/targets-view');
    const rowsOut = buildMacroRows({
      colors: COLORS,
      totals: {},
      hasEntries: false,
      targets: { ...resolved, macroMode: { mode: 'ratios', proteinPct: 30, carbsPct: 40, fatPct: 30 } },
      netCarbs: true,
      budgetExtraKcal: 719,
    });
    const [, protein, carbs, fat] = rowsOut;
    expect(protein.target).toBeCloseTo(2219 * 0.3 / 4, 1);
    expect(carbs.target).toBeCloseTo(2219 * 0.4 / 4, 1);
    expect(fat.target).toBeCloseTo(2219 * 0.3 / 9, 1);
  });

  it('fixed grams stay as typed', async () => {
    const { buildMacroRows } = await load('@/components/diary/targets-view');
    const rowsOut = buildMacroRows({
      colors: COLORS,
      totals: {},
      hasEntries: false,
      targets: { ...resolved, macroMode: { mode: 'fixed', proteinG: 120, carbsG: 150, fatG: 45 } },
      netCarbs: true,
      budgetExtraKcal: 719,
    });
    const [, protein, carbs, fat] = rowsOut;
    expect(protein.target).toBe(120);
    expect(carbs.target).toBe(150);
    expect(fat.target).toBe(45);
  });

  it('without a macro mode (an older cached resolution) the static macros are shown', async () => {
    const [energy, protein] = await loadRows(719, targets);
    expect(energy.target).toBe(2219);
    expect(protein.target).toBe(131.3);
  });
});
