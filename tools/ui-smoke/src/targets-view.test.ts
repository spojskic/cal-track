import { describe, expect, it } from 'vitest';

// The app modules are imported at run time through the `@/` alias: this package's tsconfig knows nothing about the app (React Native
// types, JSX), so a static import would not typecheck here. Same pattern as app-data-contract.test.ts.
const load = (specifier: string): Promise<any> => import(/* @vite-ignore */ specifier);

const COLORS: any = { energy: '#e', protein: '#p', carbs: '#c', fat: '#f' };
const targets: any = {
  energy: { target: 1500 },
  macros: { protein: { grams: 131.3 }, carbs: { grams: 131.3 }, fat: { grams: 50 } },
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
