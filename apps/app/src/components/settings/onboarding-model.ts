import {
  parseBirthdateInput,
  type ActivityLevel,
  type MacroMode,
  type ResolveTargetsInput,
  type Sex,
  type UnitSystem,
} from '@cal/core';

import type { CompleteOnboardingInput } from '@/data/targets';
import type { WeightGoal } from '@/data/goals';
import type { LatestBody } from '@/data/weight';
import type { Profile } from '@/data/profile';

import { goalDraftFromSaved, goalDraftValues, type GoalDraft, type GoalValues } from './goal-draft';
import {
  EMPTY_HEIGHT,
  heightToInput,
  kgToInput,
  numberToInput,
  parseBodyFatInput,
  parseHeightInput,
  parseWeightInput,
  type HeightInput,
} from './inputs';
import { draftFromMode, draftFromPreset, draftToMode, type MacroDraft } from './macro-draft';

export const TOTAL_STEPS = 6;

export const STEP_TITLES = [
  'About you',
  'Your weight',
  'Activity level',
  'Your goal',
  'Macro style',
  'Your plan',
] as const;

export const STEP_SUBTITLES = [
  'We use these details to estimate your daily energy needs and nutrient targets.',
  'Your current weight is the starting point for every calculation.',
  'How active are you on a typical day, outside of workouts?',
  'Pick a direction and a pace. You can change this any time.',
  'How should your calories be split between protein, carbs and fat?',
  'Review your daily targets, then finish setup.',
] as const;

/** Everything the wizard collects, as typed. */
export interface OnboardingForm {
  unitSystem: UnitSystem;
  sex: Sex | null;
  birthdate: string;
  height: HeightInput;
  pregnant: boolean;
  lactating: boolean;
  weight: string;
  bodyFat: string;
  activity: ActivityLevel;
  goal: GoalDraft;
  macro: MacroDraft;
  /** Existing profile preference (not edited in the wizard). */
  netCarbs: boolean;
}

export interface OnboardingSources {
  profile: Profile | null | undefined;
  body: LatestBody | undefined;
  goal: WeightGoal | null | undefined;
  macroMode: MacroMode | null | undefined;
}

/** Starting form values: existing data when the user re-runs onboarding, sensible defaults otherwise. */
export function initialForm({ profile, body, goal, macroMode }: OnboardingSources): OnboardingForm {
  const unitSystem: UnitSystem = profile?.unit_system ?? 'metric';
  return {
    unitSystem,
    sex: profile?.sex ?? null,
    birthdate: profile?.birthdate ?? '',
    height: profile?.height_cm ? heightToInput(Number(profile.height_cm), unitSystem) : EMPTY_HEIGHT,
    pregnant: profile?.pregnant ?? false,
    lactating: profile?.lactating ?? false,
    weight: body?.weightKg ? kgToInput(body.weightKg, unitSystem) : '',
    bodyFat: body?.bodyFatPct !== null && body?.bodyFatPct !== undefined ? numberToInput(body.bodyFatPct, 1) : '',
    activity: profile?.activity_level ?? 'sedentary',
    goal: goalDraftFromSaved(goal ?? null, unitSystem),
    macro: macroMode ? draftFromMode(macroMode, null) : draftFromPreset('balanced'),
    netCarbs: profile?.net_carbs ?? true,
  };
}

export interface OnboardingErrors {
  sex?: string;
  birthdate?: string;
  height?: string;
  weight?: string;
  bodyFat?: string;
  goalRate?: string;
  goalTarget?: string;
}

export interface ParsedOnboarding {
  birthdateISO: string | null;
  heightCm: number | null;
  weightKg: number | null;
  bodyFatPct: number | null;
  goal: GoalValues;
  /** null when the macro draft cannot be parsed (the editor shows why). */
  macroMode: MacroMode | null;
  errors: OnboardingErrors;
}

/** Validates and converts the whole form (errors are always computed; the UI decides when to show them). */
export function parseOnboarding(form: OnboardingForm, today: string): ParsedOnboarding {
  const errors: OnboardingErrors = {};

  if (form.sex === null) errors.sex = 'Choose male or female (used for energy and nutrient guidelines).';

  const birth = parseBirthdateInput(form.birthdate, today);
  if (!birth.ok) errors.birthdate = birth.error;

  const height = parseHeightInput(form.height, form.unitSystem);
  if (height.error) errors.height = height.error;

  const weight = parseWeightInput(form.weight, form.unitSystem);
  if (weight.error) errors.weight = weight.error;

  const fat = parseBodyFatInput(form.bodyFat);
  if (fat.error) errors.bodyFat = fat.error;

  const goal = goalDraftValues(form.goal, form.unitSystem, weight.value);
  if (goal.errors.rate) errors.goalRate = goal.errors.rate;
  if (goal.errors.target) errors.goalTarget = goal.errors.target;

  return {
    birthdateISO: birth.ok ? birth.iso : null,
    heightCm: height.value,
    weightKg: weight.value,
    bodyFatPct: fat.value,
    goal,
    macroMode: draftToMode(form.macro).mode,
    errors,
  };
}

/** Which error keys block each step (1-based). */
export const STEP_ERROR_KEYS: Record<number, readonly (keyof OnboardingErrors)[]> = {
  1: ['sex', 'birthdate', 'height'],
  2: ['weight', 'bodyFat'],
  3: [],
  4: ['goalRate', 'goalTarget'],
  5: [],
  6: [],
};

export function stepHasErrors(parsed: ParsedOnboarding, step: number): boolean {
  return (STEP_ERROR_KEYS[step] ?? []).some((key) => parsed.errors[key] !== undefined);
}

/** Core resolver input for the live preview, or null while the basics are incomplete. */
export function toResolveInput(
  form: OnboardingForm,
  parsed: ParsedOnboarding,
  today: string,
): ResolveTargetsInput | null {
  if (form.sex === null || !parsed.birthdateISO || parsed.heightCm === null || parsed.weightKg === null) {
    return null;
  }
  return {
    sex: form.sex,
    birthdate: parsed.birthdateISO,
    heightCm: parsed.heightCm,
    weightKg: parsed.weightKg,
    bodyFatPct: parsed.bodyFatPct,
    activityLevel: form.activity,
    rateKgPerWeek: parsed.goal.errors.rate ? 0 : parsed.goal.rateKgPerWeek,
    macroMode: parsed.macroMode,
    netCarbs: form.netCarbs,
    pregnant: form.sex === 'female' && form.pregnant,
    lactating: form.sex === 'female' && form.lactating,
    onDate: today,
  };
}

/** Payload for `useCompleteOnboarding`; null if the form is not valid. */
export function toSaveInput(
  form: OnboardingForm,
  parsed: ParsedOnboarding,
  macroMode: MacroMode,
): CompleteOnboardingInput | null {
  if (form.sex === null || !parsed.birthdateISO || parsed.heightCm === null || parsed.weightKg === null) {
    return null;
  }
  const female = form.sex === 'female';
  return {
    profile: {
      sex: form.sex,
      birthdate: parsed.birthdateISO,
      height_cm: Math.round(parsed.heightCm * 10) / 10,
      unit_system: form.unitSystem,
      activity_level: form.activity,
      pregnant: female && form.pregnant,
      lactating: female && form.lactating,
    },
    weightKg: parsed.weightKg,
    bodyFatPct: parsed.bodyFatPct,
    goal: { rateKgPerWeek: parsed.goal.rateKgPerWeek, targetWeightKg: parsed.goal.targetWeightKg },
    macroMode,
  };
}
