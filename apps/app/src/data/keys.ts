import type { QueryClient } from '@tanstack/react-query';

/**
 * React Query key conventions. Everything that belongs to one diary day lives under
 * ['day', <YYYY-MM-DD>, <part>] so a single invalidation refreshes the whole day.
 */
export type DayPart = 'entries' | 'totals' | 'exercise' | 'biometrics' | 'notes' | 'water' | 'energy';

export const dayKey = (date: string, part: DayPart) => ['day', date, part] as const;

export function invalidateDay(qc: QueryClient, date: string): Promise<void> {
  return qc.invalidateQueries({ queryKey: ['day', date] });
}

/** Non-day-scoped keys. */
export const keys = {
  profile: ['profile'] as const,
  targets: ['targets'] as const,
  weightGoal: ['weight_goal'] as const,
  macroTargets: ['macro_targets'] as const,
  nutrientOverrides: ['nutrient_targets'] as const,
  latestWeight: ['biometrics', 'latest_weight'] as const,
  mealGroups: ['meal_groups'] as const,
  food: (id: string) => ['food', id] as const,
  foodSearch: (q: string, kinds?: string[]) => ['food_search', q, kinds ?? null] as const,
  favorites: ['favorites'] as const,
  recentFoods: ['recent_foods'] as const,
  myFoods: ['my_foods'] as const,
};
