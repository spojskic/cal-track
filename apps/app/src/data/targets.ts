// OWNER: profile/targets agent (replace this stub; keep the exported types and hook signature).
import type {
  EnergyTarget,
  MacroMode,
  MacroTargets,
  Targets,
} from '@cal/core';

import type { Profile } from './profile';

/** Everything the diary/dashboard needs to show targets, resolved from profile + goal + DRI + overrides. */
export interface ResolvedTargets {
  profile: Profile;
  age: number;
  weightKg: number;
  bodyFatPct: number | null;
  bmr: number;
  baselineActivityKcal: number;
  /** Signed kg/week; negative = losing. 0 when no active weight goal. */
  rateKgPerWeek: number;
  energy: EnergyTarget;
  macroMode: MacroMode;
  macros: MacroTargets;
  /** Per-nutrient min/max after intake guidelines (DRI) + user overrides. Keys are NutrientCode. */
  nutrients: Targets;
}

export interface UseTargetsResult {
  data: ResolvedTargets | undefined;
  isLoading: boolean;
  /** True when the user has not finished onboarding (no usable targets yet). */
  needsOnboarding: boolean;
}

export function useTargets(): UseTargetsResult {
  return { data: undefined, isLoading: true, needsOnboarding: false };
}
