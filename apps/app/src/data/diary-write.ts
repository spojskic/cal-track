import { useMutation, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';

import { invalidateDay, keys } from './keys';

export type DiarySource = 'manual' | 'barcode' | 'ai_photo' | 'ai_text' | 'recipe' | 'copy' | 'quick_add';

export interface NewDiaryEntry {
  foodId: string;
  /** Always stored in grams; `amount`/`portionLabel` are only for display ("2 x slice"). */
  grams: number;
  mealGroupId: string;
  /** Local YYYY-MM-DD */
  entryDate: string;
  source?: DiarySource;
  amount?: number;
  portionLabel?: string;
  aiConfidence?: number;
  note?: string;
}

/** Inserts one diary entry. The DB trigger maintains daily_totals and food usage ranking. */
export function useAddDiaryEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (e: NewDiaryEntry) => {
      const { data: auth } = await supabase.auth.getUser();
      const userId = auth.user?.id;
      if (!userId) throw new Error('Not signed in');
      const { data, error } = await supabase
        .from('diary_entries')
        .insert({
          user_id: userId,
          entry_date: e.entryDate,
          meal_group_id: e.mealGroupId,
          food_id: e.foodId,
          grams: e.grams,
          amount: e.amount ?? null,
          portion_label: e.portionLabel ?? null,
          source: e.source ?? 'manual',
          ai_confidence: e.aiConfidence ?? null,
          note: e.note ?? null,
        })
        .select('id')
        .single();
      if (error) throw error;
      return data as { id: string };
    },
    onSuccess: async (_d, e) => {
      await invalidateDay(qc, e.entryDate);
      await qc.invalidateQueries({ queryKey: keys.recentFoods });
    },
  });
}
