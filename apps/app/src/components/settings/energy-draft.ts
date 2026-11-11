import {
  DEFAULT_ACTIVITY_LEVEL,
  normalizeEnergySummaryMode,
  parseNumber,
  type ActivityLevel,
  type BmrFormula,
  type EnergyMode,
  type EnergySummaryMode,
} from '@ration/core';

import type { Profile, ProfilePatch } from '@/data/profile';

import { numberToInput, type Parsed } from './inputs';

/** Energy-calculation settings as edited on the targets screen. */
export interface EnergyDraft {
  bmrFormula: BmrFormula;
  /** Manual BMR text (kcal/day); only used with the 'manual' formula. */
  manualBmr: string;
  activity: ActivityLevel;
  tef: boolean;
  energyMode: EnergyMode;
  /** What the third circle of the energy summary shows: Target or Balance. */
  summaryMode: EnergySummaryMode;
  netCarbs: boolean;
}

export function energyDraftFromProfile(p: Profile): EnergyDraft {
  return {
    bmrFormula: p.bmr_formula,
    manualBmr: p.bmr_override !== null && p.bmr_override !== undefined ? numberToInput(Number(p.bmr_override), 0) : '',
    activity: p.activity_level ?? DEFAULT_ACTIVITY_LEVEL,
    tef: p.tef_enabled,
    energyMode: p.energy_mode,
    summaryMode: normalizeEnergySummaryMode(p.energy_summary_mode),
    netCarbs: p.net_carbs,
  };
}

export function energyDraftEqual(a: EnergyDraft, b: EnergyDraft): boolean {
  return (
    a.bmrFormula === b.bmrFormula &&
    (a.bmrFormula !== 'manual' || a.manualBmr.trim() === b.manualBmr.trim()) &&
    a.activity === b.activity &&
    a.tef === b.tef &&
    a.energyMode === b.energyMode &&
    a.summaryMode === b.summaryMode &&
    a.netCarbs === b.netCarbs
  );
}

export function parseManualBmr(text: string): Parsed<number> {
  const n = parseNumber(text);
  if (n === null || n < 500 || n > 5000) {
    return { value: null, error: 'Enter your resting energy in kcal per day, between 500 and 5000.' };
  }
  return { value: n, error: null };
}

/** Profile columns for the draft. The manual BMR is only written when that formula is selected. */
export function energyDraftToPatch(d: EnergyDraft): ProfilePatch {
  const patch: ProfilePatch = {
    bmr_formula: d.bmrFormula,
    activity_level: d.activity,
    tef_enabled: d.tef,
    energy_mode: d.energyMode,
    energy_summary_mode: d.summaryMode,
    net_carbs: d.netCarbs,
  };
  if (d.bmrFormula === 'manual') patch.bmr_override = parseManualBmr(d.manualBmr).value;
  return patch;
}
