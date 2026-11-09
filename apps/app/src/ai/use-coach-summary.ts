import type { CoachSummary } from '@cal/ai';
import { useCallback, useEffect, useRef } from 'react';

import { fetchCoachGrounding } from '@/data/coach';
import { useActiveWeightGoal } from '@/data/goals';
import { useProfile } from '@/data/profile';
import { useTargets } from '@/data/targets';
import { todayISO } from '@/state/selected-date';

import { buildCoachSummary, summaryTargetsFrom } from './coach-summary';

/**
 * Returns a stable `build()` that assembles a FRESH {@link CoachSummary} for one coach turn.
 *
 * - Intake (daily_totals), weight, exercise, device energy and sleep are read from Supabase at call time, so a
 *   meal logged a minute ago is already in it (nothing comes from a possibly stale cache).
 * - Targets, goal and profile come from the live hooks (`useTargets`, `useActiveWeightGoal`, `useProfile`);
 *   they are kept in a ref so `build` itself never changes identity and never captures old values.
 * - Never rejects: a series that cannot be loaded is left out and the coach is told nothing about it.
 */
export function useCoachSummary(): () => Promise<CoachSummary> {
  const targetsQ = useTargets();
  const goalQ = useActiveWeightGoal();
  const profileQ = useProfile();

  const latest = useRef({ targets: targetsQ.data, goal: goalQ.data, profile: profileQ.data });
  useEffect(() => {
    latest.current = { targets: targetsQ.data, goal: goalQ.data, profile: profileQ.data };
  });

  return useCallback(async (): Promise<CoachSummary> => {
    const today = todayISO();
    const rows = await fetchCoachGrounding(today).catch(() => null);
    const { targets, goal, profile } = latest.current;
    const p = targets?.profile ?? profile ?? null;

    return buildCoachSummary({
      today,
      targets: targets ? summaryTargetsFrom(targets) : null,
      profile: p
        ? {
            sex: p.sex,
            ageYears: targets?.age ?? null,
            heightCm: p.height_cm,
            activityLevel: p.activity_level,
          }
        : null,
      rateKgPerWeek: targets?.rateKgPerWeek ?? goal?.rate_kg_per_week ?? null,
      targetWeightKg: goal?.target_weight_kg ?? null,
      macroMode: targets?.macroMode ?? null,
      energyMode: p?.energy_mode ?? null,
      netCarbs: p?.net_carbs ?? null,
      latestWeightKg: targets?.weightKg ?? null,
      dailyTotals: rows?.dailyTotals ?? null,
      weight: rows?.weight ?? null,
      exercise: rows?.exercise ?? null,
      deviceEnergy: rows?.deviceEnergy ?? null,
      biometrics: rows?.biometrics ?? null,
    });
  }, []);
}
