import { describe, expect, it } from 'vitest';
import * as core from './index';

describe('public API', () => {
  it('exports the documented entry points', () => {
    const names = [
      // catalog
      'NUTRIENTS', 'NUTRIENT_BY_CODE', 'NUTRIENT_BY_FDC_ID', 'NUTRIENT_GROUPS',
      // diary
      'scaleNutrients', 'addNutrients', 'sumNutrients', 'sumEntries', 'deriveNutrients', 'completeness',
      // units
      'formatWeight', 'formatHeight', 'gramsFromVolume', 'gramsFor',
      // energy
      'bmrMifflin', 'bmrKatchMcArdle', 'bmrHarrisBenedictRevised', 'bmrCunningham', 'leanMass', 'computeBmr',
      'baselineActivityKcal', 'exerciseKcalNetMet', 'tefKcal', 'computeExpenditure', 'dedupeExercises',
      'AWAKE_HOURS', 'adjustedBaselineKcal', 'energyRemaining', 'energySummaryCaption', 'normalizeEnergySummaryMode', 'nextEnergySummaryMode',
      'dailyDeltaFromRate', 'maxSafeLossRateKgPerWeek', 'computeEnergyTarget', 'ageFromBirthdate',
      // macros, dri, exercises, recipe, score
      'computeMacroTargets', 'DRI_TABLE', 'selectTargets', 'applyOverrides', 'MET_ACTIVITIES',
      'computeRecipe', 'nutritionScore',
    ];
    for (const name of names) expect(core, name).toHaveProperty(name);
  });
});
