import { kgToLb, lbToKg, parseNumber, type UnitSystem } from '@ration/core';

import { kgToInput, numberToInput, parseWeightInput, weightUnitLabel } from './inputs';

export type GoalType = 'maintain' | 'lose' | 'gain';

/** Weight goal as typed: magnitude per week and optional target, both in the user's unit. */
export interface GoalDraft {
  type: GoalType;
  /** Positive weekly rate in kg or lb per week (direction comes from `type`). */
  rate: string;
  /** Optional target weight in kg or lb. */
  target: string;
}

/** Upper bound on a typed weekly rate (kg). */
export const MAX_RATE_KG = 2;

export const RATE_PRESETS: Record<'lose' | 'gain', Record<UnitSystem, readonly number[]>> = {
  lose: { metric: [0.25, 0.5, 0.75, 1], imperial: [0.5, 1, 1.5, 2] },
  gain: { metric: [0.25, 0.5], imperial: [0.5, 1] },
};

export function defaultRateText(type: 'lose' | 'gain', system: UnitSystem): string {
  return String(type === 'lose' ? (system === 'metric' ? 0.5 : 1) : system === 'metric' ? 0.25 : 0.5);
}

/** Typed weekly rate -> kg per week (positive), or null if unusable. */
export function rateTextToKg(text: string, system: UnitSystem): number | null {
  const n = parseNumber(text);
  if (n === null) return null;
  return system === 'metric' ? n : lbToKg(n);
}

export interface GoalValues {
  /** Signed kg/week (negative = lose). */
  rateKgPerWeek: number;
  targetWeightKg: number | null;
  errors: { rate?: string; target?: string };
}

/** Validates the draft and converts it to storage values. */
export function goalDraftValues(draft: GoalDraft, system: UnitSystem, currentWeightKg: number | null): GoalValues {
  if (draft.type === 'maintain') return { rateKgPerWeek: 0, targetWeightKg: null, errors: {} };

  const errors: GoalValues['errors'] = {};
  const unit = weightUnitLabel(system);
  const rateKg = rateTextToKg(draft.rate, system);
  let signedRate = 0;
  if (rateKg === null || rateKg <= 0) {
    errors.rate = `Enter a weekly rate in ${unit}, e.g. ${defaultRateText(draft.type, system)}.`;
  } else if (rateKg > MAX_RATE_KG) {
    errors.rate = `The weekly rate cannot exceed ${numberToInput(system === 'metric' ? MAX_RATE_KG : kgToLb(MAX_RATE_KG), 1)} ${unit}.`;
  } else {
    signedRate = draft.type === 'lose' ? -rateKg : rateKg;
  }

  let targetWeightKg: number | null = null;
  if (draft.target.trim() !== '') {
    const parsed = parseWeightInput(draft.target, system);
    if (parsed.error || parsed.value === null) {
      errors.target = parsed.error ?? 'Enter a valid target weight.';
    } else if (currentWeightKg !== null && draft.type === 'lose' && parsed.value >= currentWeightKg) {
      errors.target = 'For weight loss, the target must be below your current weight.';
    } else if (currentWeightKg !== null && draft.type === 'gain' && parsed.value <= currentWeightKg) {
      errors.target = 'For weight gain, the target must be above your current weight.';
    } else {
      targetWeightKg = parsed.value;
    }
  }
  return { rateKgPerWeek: signedRate, targetWeightKg, errors };
}

/** Builds the editable draft from a saved goal (null = no goal = maintain). */
export function goalDraftFromSaved(
  saved: { rate_kg_per_week: number; target_weight_kg: number; start_weight_kg: number } | null,
  system: UnitSystem,
): GoalDraft {
  if (!saved || Math.abs(saved.rate_kg_per_week) < 0.0005) return { type: 'maintain', rate: '', target: '' };
  const type: GoalType = saved.rate_kg_per_week < 0 ? 'lose' : 'gain';
  const mag = Math.abs(saved.rate_kg_per_week);
  const hasTarget = Math.abs(saved.target_weight_kg - saved.start_weight_kg) > 0.01;
  return {
    type,
    rate: numberToInput(system === 'metric' ? mag : kgToLb(mag), 2),
    target: hasTarget ? kgToInput(saved.target_weight_kg, system) : '',
  };
}

/** Re-expresses a typed goal in another unit system (unparsable text is kept). */
export function convertGoalDraft(draft: GoalDraft, from: UnitSystem, to: UnitSystem): GoalDraft {
  if (from === to) return draft;
  const rateKg = rateTextToKg(draft.rate, from);
  const target = parseWeightInput(draft.target, from);
  return {
    type: draft.type,
    rate: rateKg === null ? draft.rate : numberToInput(to === 'metric' ? rateKg : kgToLb(rateKg), 2),
    target: target.value === null ? draft.target : kgToInput(target.value, to),
  };
}

/** "Lose 0.5 kg per week", "Gain 1.1 lb per week" or "Maintain weight". */
export function describeRate(rateKgPerWeek: number, system: UnitSystem): string {
  if (Math.abs(rateKgPerWeek) < 0.0005) return 'Maintain weight';
  const mag = Math.abs(rateKgPerWeek);
  const amount = numberToInput(system === 'metric' ? mag : kgToLb(mag), 2);
  return `${rateKgPerWeek < 0 ? 'Lose' : 'Gain'} ${amount} ${weightUnitLabel(system)} per week`;
}

/** Whole weeks to travel from the current to the target weight at a signed rate; null if not heading there. */
export function weeksToTarget(currentKg: number, targetKg: number, rateKgPerWeek: number): number | null {
  const delta = targetKg - currentKg;
  if (rateKgPerWeek === 0 || delta === 0 || Math.sign(delta) !== Math.sign(rateKgPerWeek)) return null;
  return Math.ceil(delta / rateKgPerWeek);
}
