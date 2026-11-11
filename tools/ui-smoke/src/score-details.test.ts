import { describe, expect, it } from 'vitest';

// Same run-time `@/` import pattern as targets-view.test.ts.
const load = (specifier: string): Promise<any> => import(/* @vite-ignore */ specifier);

const result: any = (perNutrient: Record<string, any>) => ({ score: 0, coverage: 1, perNutrient });

describe('scoreDetails: why the nutrition score is what it is', () => {
  it('averages the reached targets by weight and lists the limits that were exceeded, the costliest first', async () => {
    const { scoreDetails } = await load('@/components/diary/score-details');
    const details = scoreDetails(
      result({
        PROTEIN_G: { weight: 1, intake: 100, min: 100, fulfillment: 1 },
        FIBER_G: { weight: 1, intake: 10, min: 40, fulfillment: 0.25 },
        SODIUM_MG: { weight: 1, intake: 4600, max: 2300, excess: 1 },
        SATURATED_FAT_G: { weight: 1, intake: 25, max: 20, excess: 0.25 },
        ADDED_SUGARS_G: { weight: 1, intake: 10, max: 50, excess: 0 },
      }),
    );
    expect(details.reachedPercent).toBe(63);
    expect(details.overLimits.map((o: any) => [o.code, o.percent])).toEqual([
      ['SODIUM_MG', 200],
      ['SATURATED_FAT_G', 125],
    ]);
  });

  it('keeps at most three over-limit nutrients', async () => {
    const { scoreDetails } = await load('@/components/diary/score-details');
    const over = Object.fromEntries(
      ['SODIUM_MG', 'SATURATED_FAT_G', 'ADDED_SUGARS_G', 'CAFFEINE_MG'].map((code, i) => [
        code,
        { weight: 1, intake: 200 + i, max: 100, excess: 1 + i / 100 },
      ]),
    );
    expect((await scoreDetails(result(over))).overLimits).toHaveLength(3);
  });

  it('says nothing without data, and only names the limits that were exceeded', async () => {
    const { scoreDetailText } = await load('@/components/diary/score-details');
    expect(scoreDetailText(result({}))).toBeUndefined();
    expect(scoreDetailText(result({ PROTEIN_G: { weight: 1, intake: 50, min: 100, fulfillment: 0.5 } }))).toBe(
      'Targets reached: 50% on average.',
    );
    const text = scoreDetailText(
      result({ SODIUM_MG: { weight: 1, intake: 4600, max: 2300, excess: 1 } }),
    );
    expect(text).toContain('Over a limit: Sodium 200%');
    expect(text).toContain('takes points off');
  });
});
