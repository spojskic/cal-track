import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  macroModeFromColumns,
  macroModeToColumns,
  type MacroMode,
  type NutrientCode,
  type TargetOverride,
} from '@cal/core';

import { requireUserId } from '@/lib/auth-user';
import { supabase } from '@/lib/supabase';
import { todayISO } from '@/state/selected-date';

import { keys } from './keys';
import { useUserId } from './profile';

// ----------------------------------------------------------------- weight goal

/** Row of public.weight_goals. `rate_kg_per_week` is signed: negative = lose. */
export interface WeightGoal {
  id: string;
  start_weight_kg: number;
  target_weight_kg: number;
  rate_kg_per_week: number;
  start_date: string;
  active: boolean;
}

function normalizeGoal(row: Record<string, unknown>): WeightGoal {
  return {
    id: String(row.id),
    start_weight_kg: Number(row.start_weight_kg),
    target_weight_kg: Number(row.target_weight_kg),
    rate_kg_per_week: Number(row.rate_kg_per_week),
    start_date: String(row.start_date),
    active: Boolean(row.active),
  };
}

/** The user's active weight goal (null when none). */
export function useActiveWeightGoal() {
  const userId = useUserId();
  return useQuery({
    queryKey: [...keys.weightGoal, userId ?? 'anon'],
    enabled: Boolean(userId),
    queryFn: async (): Promise<WeightGoal | null> => {
      const { data, error } = await supabase
        .from('weight_goals')
        .select('id,start_weight_kg,target_weight_kg,rate_kg_per_week,start_date,active')
        .eq('active', true)
        .order('start_date', { ascending: false })
        .limit(1);
      if (error) throw error;
      const row = (data ?? [])[0] as Record<string, unknown> | undefined;
      return row ? normalizeGoal(row) : null;
    },
  });
}

export interface SaveWeightGoalInput {
  /** Signed kg/week (negative = lose, 0 = maintain). */
  rateKgPerWeek: number;
  /** Goal weight in kg; defaults to the start weight (maintain). */
  targetWeightKg?: number | null;
  /** Weight at the start of the goal in kg (used when a goal row is created). */
  startWeightKg: number;
  /**
   * true: deactivate every active goal and insert a fresh one (new goal, new start date).
   * false (default): update the active goal in place, or insert one if there is none.
   */
  replace?: boolean;
}

/** Writes the weight goal. Does not touch caches. */
export async function saveWeightGoalRow(input: SaveWeightGoalInput): Promise<void> {
  const userId = await requireUserId();
  const target = input.targetWeightKg ?? input.startWeightKg;
  const rate = Math.round(input.rateKgPerWeek * 1000) / 1000;

  if (!input.replace) {
    const { data, error } = await supabase
      .from('weight_goals')
      .select('id')
      .eq('active', true)
      .order('start_date', { ascending: false })
      .limit(1);
    if (error) throw error;
    const existing = (data ?? [])[0] as { id: string } | undefined;
    if (existing) {
      const { error: updateError } = await supabase
        .from('weight_goals')
        .update({ rate_kg_per_week: rate, target_weight_kg: target })
        .eq('id', existing.id);
      if (updateError) throw updateError;
      return;
    }
  } else {
    const { error } = await supabase.from('weight_goals').update({ active: false }).eq('active', true);
    if (error) throw error;
  }

  const { error } = await supabase.from('weight_goals').insert({
    user_id: userId,
    start_weight_kg: input.startWeightKg,
    target_weight_kg: target,
    rate_kg_per_week: rate,
    start_date: todayISO(),
    active: true,
  });
  if (error) throw error;
}

export function invalidateGoalData(qc: QueryClient): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: keys.weightGoal }),
    qc.invalidateQueries({ queryKey: keys.targets }),
  ]);
}

export function useSaveWeightGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: saveWeightGoalRow,
    onSuccess: () => invalidateGoalData(qc),
  });
}

// --------------------------------------------------------------- macro targets

/** The latest effective all-days macro target. */
export interface EffectiveMacroTarget {
  /** null when the stored row is incomplete or invalid. */
  mode: MacroMode | null;
  effectiveFrom: string;
}

/** Latest `macro_targets` row with no weekday and `effective_from <= today`, as a macro mode. */
export function useMacroTarget() {
  const userId = useUserId();
  return useQuery({
    queryKey: [...keys.macroTargets, userId ?? 'anon'],
    enabled: Boolean(userId),
    queryFn: async (): Promise<EffectiveMacroTarget | null> => {
      const { data, error } = await supabase
        .from('macro_targets')
        .select('*')
        .is('weekday', null)
        .lte('effective_from', todayISO())
        .order('effective_from', { ascending: false })
        .limit(1);
      if (error) throw error;
      const row = (data ?? [])[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      return { mode: macroModeFromColumns(row), effectiveFrom: String(row.effective_from) };
    },
  });
}

/**
 * Stores a macro target effective from today. `macro_targets` has no timestamp besides
 * `effective_from`, so a second save on the same day replaces the first instead of adding a tie.
 */
export async function saveMacroTargetRow(mode: MacroMode): Promise<void> {
  const userId = await requireUserId();
  const today = todayISO();
  const columns = macroModeToColumns(mode);

  const { error: deleteError } = await supabase
    .from('macro_targets')
    .delete()
    .is('weekday', null)
    .eq('effective_from', today);
  if (deleteError) throw deleteError;

  const { error } = await supabase
    .from('macro_targets')
    .insert({ user_id: userId, weekday: null, effective_from: today, ...columns });
  if (error) throw error;
}

export function invalidateMacroData(qc: QueryClient): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: keys.macroTargets }),
    qc.invalidateQueries({ queryKey: keys.targets }),
  ]);
}

export function useSaveMacroTarget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: saveMacroTargetRow,
    onSuccess: () => invalidateMacroData(qc),
  });
}

// ----------------------------------------------------------- nutrient overrides

/** Per-nutrient overrides keyed by code. A missing bound means "use the default". */
export type NutrientOverrides = Partial<Record<NutrientCode, TargetOverride>>;

/** The user's saved nutrient target overrides (`nutrient_targets`). */
export function useNutrientOverrides() {
  const userId = useUserId();
  return useQuery({
    queryKey: [...keys.nutrientOverrides, userId ?? 'anon'],
    enabled: Boolean(userId),
    queryFn: async (): Promise<NutrientOverrides> => {
      const { data, error } = await supabase
        .from('nutrient_targets')
        .select('nutrient_code,min_value,max_value');
      if (error) throw error;
      const out: NutrientOverrides = {};
      for (const row of (data ?? []) as {
        nutrient_code: NutrientCode;
        min_value: number | string | null;
        max_value: number | string | null;
      }[]) {
        const override: TargetOverride = {};
        if (row.min_value !== null) override.min = Number(row.min_value);
        if (row.max_value !== null) override.max = Number(row.max_value);
        if (override.min !== undefined || override.max !== undefined) out[row.nutrient_code] = override;
      }
      return out;
    },
  });
}

export function invalidateOverrideData(qc: QueryClient): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: keys.nutrientOverrides }),
    qc.invalidateQueries({ queryKey: keys.targets }),
  ]);
}

export interface SetNutrientOverrideInput {
  code: NutrientCode;
  /** null/undefined = keep the default for that bound. Both empty deletes the override. */
  min?: number | null;
  max?: number | null;
}

/** Saves (or, when both bounds are empty, removes) one nutrient override. */
export function useSetNutrientOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ code, min, max }: SetNutrientOverrideInput) => {
      const userId = await requireUserId();
      if ((min === null || min === undefined) && (max === null || max === undefined)) {
        const { error } = await supabase.from('nutrient_targets').delete().eq('nutrient_code', code);
        if (error) throw error;
        return;
      }
      const { error } = await supabase.from('nutrient_targets').upsert(
        { user_id: userId, nutrient_code: code, min_value: min ?? null, max_value: max ?? null },
        { onConflict: 'user_id,nutrient_code' },
      );
      if (error) throw error;
    },
    onSuccess: () => invalidateOverrideData(qc),
  });
}

/** Removes the override of one nutrient (back to the default). */
export function useResetNutrientOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (code: NutrientCode) => {
      const { error } = await supabase.from('nutrient_targets').delete().eq('nutrient_code', code);
      if (error) throw error;
    },
    onSuccess: () => invalidateOverrideData(qc),
  });
}
