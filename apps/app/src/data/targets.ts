import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  resolveTargets,
  type EnergyTarget,
  type MacroMode,
  type MacroTargets,
  type Targets,
} from '@ration/core';

import { todayISO } from '@/state/selected-date';

import {
  saveMacroTargetRow,
  saveWeightGoalRow,
  useActiveWeightGoal,
  useMacroTarget,
  useNutrientOverrides,
  type NutrientOverrides,
  type WeightGoal,
} from './goals';
import { invalidateDay, keys } from './keys';
import {
  deviceTimeZone,
  profileKey,
  upsertProfileRow,
  useProfile,
  type Profile,
  type ProfilePatch,
} from './profile';
import { insertBodyReadings, useLatestBody, type LatestBody } from './weight';

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

interface Inputs {
  profile: Profile | null | undefined;
  body: LatestBody | undefined;
  goal: WeightGoal | null | undefined;
  macroMode: MacroMode | null | undefined;
  overrides: NutrientOverrides | undefined;
  today: string;
}

const LOADING: UseTargetsResult = { data: undefined, isLoading: true, needsOnboarding: false };
const NOTHING: UseTargetsResult = { data: undefined, isLoading: false, needsOnboarding: false };

/** Pure composition of the loaded pieces; see `resolveTargets` in @ration/core for the maths. */
function compose({ profile, body, goal, macroMode, overrides, today }: Inputs): UseTargetsResult {
  if (profile === undefined) return NOTHING; // not loaded (signed out / offline without cache)
  if (profile === null) return { data: undefined, isLoading: false, needsOnboarding: true };

  const weightKg = body?.weightKg ?? null;
  const complete =
    profile.sex !== null &&
    Boolean(profile.birthdate) &&
    typeof profile.height_cm === 'number' &&
    profile.height_cm > 0 &&
    weightKg !== null &&
    weightKg > 0;
  const needsOnboarding = !profile.onboarded || !complete;

  if (!complete || profile.sex === null || !profile.birthdate || !profile.height_cm || weightKg === null) {
    return { data: undefined, isLoading: false, needsOnboarding };
  }

  try {
    const r = resolveTargets({
      sex: profile.sex,
      birthdate: profile.birthdate,
      heightCm: Number(profile.height_cm),
      weightKg,
      bodyFatPct: body?.bodyFatPct ?? null,
      activityLevel: profile.activity_level,
      bmrFormula: profile.bmr_formula,
      bmrOverride: profile.bmr_override === null ? null : Number(profile.bmr_override),
      rateKgPerWeek: goal?.rate_kg_per_week ?? 0,
      macroMode: macroMode ?? null,
      netCarbs: profile.net_carbs,
      pregnant: profile.pregnant,
      lactating: profile.lactating,
      overrides: overrides ?? {},
      onDate: today,
    });
    return {
      data: {
        profile,
        age: r.age,
        weightKg: r.weightKg,
        bodyFatPct: r.bodyFatPct,
        bmr: r.bmr,
        baselineActivityKcal: r.baselineActivityKcal,
        rateKgPerWeek: r.rateKgPerWeek,
        energy: r.energy,
        macroMode: r.macroMode,
        macros: r.macros,
        nutrients: r.nutrients,
      },
      isLoading: false,
      needsOnboarding,
    };
  } catch {
    // Malformed stored values (e.g. an unparsable birthdate): ask the user to complete their details again.
    return { data: undefined, isLoading: false, needsOnboarding: true };
  }
}

/**
 * Resolved daily targets for TODAY. Composes the profile, latest weight/body fat (`biometrics`),
 * the active weight goal, the latest all-days macro target and the nutrient overrides through
 * `resolveTargets` (@ration/core). Missing optional pieces fall back to: no goal = rate 0,
 * no macro row = 30/40/30 ratios, no activity level = sedentary.
 *
 * Re-computed (memoised) whenever any input query changes. Inputs refresh when you invalidate
 * keys.profile / keys.latestWeight / keys.weightGoal / keys.macroTargets / keys.nutrientOverrides
 * (the mutations in data/profile, weight and goals do this and also invalidate keys.targets).
 */
export function useTargets(): UseTargetsResult {
  const profileQ = useProfile();
  const bodyQ = useLatestBody();
  const goalQ = useActiveWeightGoal();
  const macroQ = useMacroTarget();
  const overridesQ = useNutrientOverrides();
  const today = todayISO();

  const isLoading =
    profileQ.isLoading || bodyQ.isLoading || goalQ.isLoading || macroQ.isLoading || overridesQ.isLoading;

  const profile = profileQ.data;
  const body = bodyQ.data;
  const goal = goalQ.data;
  const macroMode = macroQ.data?.mode;
  const overrides = overridesQ.data;

  return useMemo(
    () => (isLoading ? LOADING : compose({ profile, body, goal, macroMode, overrides, today })),
    [isLoading, profile, body, goal, macroMode, overrides, today],
  );
}

// ------------------------------------------------------------------ onboarding

export interface CompleteOnboardingInput {
  profile: Pick<
    ProfilePatch,
    'display_name' | 'sex' | 'birthdate' | 'height_cm' | 'unit_system' | 'activity_level' | 'pregnant' | 'lactating'
  >;
  weightKg: number;
  bodyFatPct: number | null;
  goal: { rateKgPerWeek: number; targetWeightKg: number | null };
  macroMode: MacroMode;
}

/**
 * Saves the onboarding wizard: weight (+ body fat) biometrics, a fresh active weight goal
 * (previous goals deactivated), the macro target and finally the profile with `onboarded = true`
 * (written last so an interrupted save simply shows onboarding again).
 */
export function useCompleteOnboarding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CompleteOnboardingInput): Promise<Profile> => {
      const entryDate = await insertBodyReadings({
        weightKg: input.weightKg,
        bodyFatPct: input.bodyFatPct,
      });
      await saveWeightGoalRow({
        rateKgPerWeek: input.goal.rateKgPerWeek,
        targetWeightKg: input.goal.targetWeightKg,
        startWeightKg: input.weightKg,
        replace: true,
      });
      await saveMacroTargetRow(input.macroMode);
      const profile = await upsertProfileRow({
        ...input.profile,
        timezone: deviceTimeZone(),
        onboarded: true,
      });
      await invalidateDay(qc, entryDate);
      return profile;
    },
    onSuccess: async (profile) => {
      qc.setQueryData(profileKey(profile.user_id), profile);
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.profile }),
        qc.invalidateQueries({ queryKey: keys.targets }),
        qc.invalidateQueries({ queryKey: keys.weightGoal }),
        qc.invalidateQueries({ queryKey: keys.macroTargets }),
        qc.invalidateQueries({ queryKey: ['biometrics'] }),
      ]);
    },
  });
}
