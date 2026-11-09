import { ACTIVITY_FRACTIONS, type ActivityLevel, type BmrFormula, type EnergyMode } from '@cal/core';

export interface OptionDef<T extends string> {
  value: T;
  label: string;
  description: string;
}

export const ACTIVITY_OPTIONS: readonly OptionDef<ActivityLevel>[] = [
  {
    value: 'sedentary',
    label: 'Sedentary',
    description: 'Mostly sitting: a desk or home-based day with short walks. Roughly under 5,000 steps.',
  },
  {
    value: 'light',
    label: 'Lightly active',
    description: 'On your feet part of the day: regular walking, teaching, light chores. Roughly 5,000 to 10,000 steps.',
  },
  {
    value: 'moderate',
    label: 'Moderately active',
    description: 'Moving most of the day: lots of walking or standing, such as nursing, retail or hospitality. Roughly 10,000 to 15,000 steps.',
  },
  {
    value: 'very',
    label: 'Very active',
    description: 'Physical work all day: construction, farming, delivering on foot. Roughly 15,000+ steps.',
  },
];

export const ACTIVITY_NOTE =
  'Describe everyday movement only, not workouts. Exercise you log (and device activity, if enabled) is added to your budget separately.';

export function activityLabel(level: ActivityLevel): string {
  return ACTIVITY_OPTIONS.find((o) => o.value === level)?.label ?? level;
}

/** "+20% of BMR" for the baseline activity fraction of a level. */
export function activityBoost(level: ActivityLevel): string {
  return `+${Math.round(ACTIVITY_FRACTIONS[level] * 100)}% of BMR`;
}

export interface BmrFormulaDef extends OptionDef<BmrFormula> {
  needsBodyFat: boolean;
}

export const BMR_FORMULA_OPTIONS: readonly BmrFormulaDef[] = [
  {
    value: 'mifflin',
    label: 'Mifflin-St Jeor',
    description: 'Default. Estimated from weight, height, age and sex.',
    needsBodyFat: false,
  },
  {
    value: 'katch_mcardle',
    label: 'Katch-McArdle',
    description: 'Based on lean body mass, so it needs a body fat percentage.',
    needsBodyFat: true,
  },
  {
    value: 'cunningham',
    label: 'Cunningham',
    description: 'Lean-mass formula, often used for athletes. Needs a body fat percentage.',
    needsBodyFat: true,
  },
  {
    value: 'harris_benedict',
    label: 'Harris-Benedict (revised)',
    description: 'Older weight, height, age and sex formula.',
    needsBodyFat: false,
  },
  {
    value: 'manual',
    label: 'Manual',
    description: 'Enter your own resting energy, for example from a metabolic test.',
    needsBodyFat: false,
  },
];

export function bmrFormulaLabel(formula: BmrFormula): string {
  return BMR_FORMULA_OPTIONS.find((o) => o.value === formula)?.label ?? formula;
}

export const ENERGY_MODE_OPTIONS: readonly OptionDef<EnergyMode>[] = [
  {
    value: 'static',
    label: 'Static',
    description:
      'Your budget is BMR plus baseline activity, plus any exercise you log. Data from other apps is ignored.',
  },
  {
    value: 'device_adjusted',
    label: 'Device-adjusted',
    description:
      'Keeps BMR plus baseline as a floor and adds only the activity energy your watch or phone measured above that baseline. Takes effect once Apple Health or Health Connect data exists; until then it behaves like Static.',
  },
  {
    value: 'device_total',
    label: 'Device total',
    description:
      "Trusts your device completely: its measured active and resting energy replace our estimate. Takes effect once Apple Health or Health Connect data exists; until then it falls back to Static.",
  },
];

export const MEDICAL_DISCLAIMER =
  'Cal Track gives general estimates for informational purposes only. It is not medical advice. Talk to a doctor or registered dietitian before making big changes to what you eat, especially if you are pregnant, have a medical condition or a history of disordered eating.';
