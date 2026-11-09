import { useQuery } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';

export interface MealGroup {
  id: string;
  name: string;
  sort_order: number;
  hidden: boolean;
}

export const mealGroupsKey = ['meal_groups'] as const;

/** The user's meal groups (Breakfast, Lunch, Dinner, Snacks by default), in display order. */
export function useMealGroups() {
  return useQuery({
    queryKey: mealGroupsKey,
    queryFn: async (): Promise<MealGroup[]> => {
      const { data, error } = await supabase
        .from('meal_groups')
        .select('id,name,sort_order,hidden')
        .order('sort_order', { ascending: true });
      if (error) throw error;
      return (data ?? []) as MealGroup[];
    },
    staleTime: 5 * 60_000,
  });
}

/** Picks a sensible default group for "now" (breakfast before 11, lunch before 16, dinner before 21). */
export function defaultMealGroupId(groups: MealGroup[], now = new Date()): string | undefined {
  const visible = groups.filter((g) => !g.hidden);
  if (visible.length === 0) return undefined;
  const h = now.getHours();
  const want = h < 11 ? 'breakfast' : h < 16 ? 'lunch' : h < 21 ? 'dinner' : 'snacks';
  return (visible.find((g) => g.name.toLowerCase().startsWith(want.slice(0, 5))) ?? visible[0])?.id;
}
