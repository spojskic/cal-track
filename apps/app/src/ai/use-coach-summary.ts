import type { CoachSummary } from '@ration/ai';
import { useCallback, useEffect, useRef } from 'react';

import { fetchCoachGrounding } from '@/data/coach';
import { useActiveWeightGoal } from '@/data/goals';
import { useProfile } from '@/data/profile';
import { useTargets } from '@/data/targets';
import { todayISO } from '@/state/selected-date';

import { buildCoachSummary, latestWorkoutId, summaryNutrientTargetsFrom, summaryTargetsFrom } from './coach-summary';
import { workoutDetailSections, type CoachTopic } from './coach-topic';
import { loadWorkoutCoachContext } from './workout-context';

/** A slow or failing workout lookup must never hold up a coach turn. */
const WORKOUT_CONTEXT_TIMEOUT_MS = 6000;

/** `loadWorkoutCoachContext` that never throws and never takes longer than the timeout; null = nothing known. */
async function workoutContext(id: string | undefined): Promise<string | null> {
  if (!id) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      loadWorkoutCoachContext(id),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), WORKOUT_CONTEXT_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface CoachSummaryOptions {
  /** What the conversation is about. Its workout is described in full on every turn. */
  topic?: CoachTopic | null;
}

/**
 * Returns a stable `build()` that assembles a FRESH {@link CoachSummary} for one coach turn.
 *
 * - Intake (daily_totals incl. nutrients), weight, workouts, device energy, sleep, HRV / resting heart rate and water are
 *   read from Supabase at call time, so a meal logged a minute ago is already in it (nothing comes from a possibly stale
 *   cache). The summary starts with findings computed from those rows (see coach-summary.ts).
 * - Targets, goal and profile come from the live hooks (`useTargets`, `useActiveWeightGoal`, `useProfile`);
 *   they are kept in a ref so `build` itself never changes identity and never captures old values.
 * - A topic thread adds a description of that workout (`loadWorkoutCoachContext`, owned by the Workouts feature); a chat
 *   without a topic adds the latest workout's details when there are any.
 * - Never rejects: a series that cannot be loaded is left out and the coach is told nothing about it.
 */
export function useCoachSummary(): (options?: CoachSummaryOptions) => Promise<CoachSummary> {
  const targetsQ = useTargets();
  const goalQ = useActiveWeightGoal();
  const profileQ = useProfile();

  const latest = useRef({ targets: targetsQ.data, goal: goalQ.data, profile: profileQ.data });
  useEffect(() => {
    latest.current = { targets: targetsQ.data, goal: goalQ.data, profile: profileQ.data };
  });

  return useCallback(async (options: CoachSummaryOptions = {}): Promise<CoachSummary> => {
    const today = todayISO();
    const rows = await fetchCoachGrounding(today).catch(() => null);
    const { targets, goal, profile } = latest.current;
    const p = targets?.profile ?? profile ?? null;

    const topicId = options.topic?.kind === 'workout' ? options.topic.id : undefined;
    const lastId = latestWorkoutId(rows?.exercise);
    const [topicText, latestText] = await Promise.all([
      workoutContext(topicId),
      topicId || !lastId ? Promise.resolve(null) : workoutContext(lastId),
    ]);

    return buildCoachSummary({
      today,
      targets: targets ? summaryTargetsFrom(targets) : null,
      nutrientTargets: targets ? summaryNutrientTargetsFrom(targets.nutrients) : null,
      bmrKcal: targets?.bmr ?? null,
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
      water: rows?.water ?? null,
      lastLoggedDate: rows?.lastLoggedDate ?? null,
      workoutDetails: workoutDetailSections({ topicText, latestText }),
    });
  }, []);
}
