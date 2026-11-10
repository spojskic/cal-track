// OWNER: AI agent. Creates `ai_estimate` foods for items the food database could not match.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { completeness as computeCompleteness } from '@cal/core';
import type { NutrientEstimate } from '@cal/ai';

import { requireUserId } from '@/lib/auth-user';
import { supabase } from '@/lib/supabase';

import { cleanNutrients, prepareNutrients } from './foods';
import { keys } from './keys';

export interface AiEstimateFoodInput {
  name: string;
  /** Per-100 g numbers guessed by the AI (validated by @cal/ai `sanitizeNutrientEstimate`). */
  estimate: NutrientEstimate;
}

/**
 * Saves an AI nutrient estimate as the user's own food: `kind = 'ai_estimate'`, `source = 'ai_estimate'`.
 * It shows the "AI" badge everywhere (search, diary, details) and ranks below real database foods.
 * Never presented as verified data.
 */
export async function createAiEstimateFood(input: AiEstimateFoodInput): Promise<{ id: string }> {
  const userId = await requireUserId();
  const nutrients = prepareNutrients(cleanNutrients(input.estimate.per100g), 'includes_fiber');
  if (nutrients.ENERGY_KCAL === undefined) throw new Error('The AI estimate has no usable energy value.');
  const name = input.name.trim();
  if (!name) throw new Error('A food needs a name.');

  const { data, error } = await supabase
    .from('foods')
    .insert({
      owner_id: userId,
      source: 'ai_estimate',
      kind: 'ai_estimate',
      name,
      brand: null,
      nutrients,
      completeness: computeCompleteness(nutrients),
      carb_basis: 'includes_fiber',
    })
    .select('id')
    .single();
  if (error) throw error;
  return { id: String((data as { id: unknown }).id) };
}

/** Mutation wrapper that refreshes "My foods" and search results afterwards. */
export function useCreateAiEstimateFood() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createAiEstimateFood,
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.myFoods }),
        qc.invalidateQueries({ queryKey: ['food_search'] }),
      ]);
    },
  });
}
