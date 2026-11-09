import {
  draftRecipeFromText,
  estimateMissing,
  isAbortError,
  matchItems,
  parseMealFromImage,
  parseMealFromText,
  type MatchDeps,
  type MealType,
  type NutrientEstimate,
  type ParsedMeal,
  type ParsedMealItem,
  type RecipeDraft,
} from '@cal/ai';

import { buildReviewItems, type ReviewItem } from '@/components/ai/review-model';

import type { PreparedImage } from './image';
import { foodMatchDeps } from './search-adapter';
import type { AiClientHandle } from './use-ai-client';

/**
 * parse (LLM: foods + grams only) -> match (OUR database provides nutrients) -> estimate (LLM, ONLY for
 * unmatched foods, flagged as AI estimate). Everything runs on the device; the OpenRouter key never leaves it.
 */

export type PipelineStage = 'analyzing' | 'matching' | 'estimating';

export const STAGE_LABEL: Record<PipelineStage, string> = {
  analyzing: 'Asking the AI to identify the foods...',
  matching: 'Matching foods in the database...',
  estimating: 'Estimating foods that are not in the database...',
};

export class FoodSearchUnavailableError extends Error {
  constructor() {
    super('Could not search the food database. Check your connection and try again.');
    this.name = 'FoodSearchUnavailableError';
  }
}

/** The AI answered but found nothing to log. */
export class NoFoodsFoundError extends Error {
  constructor(what: 'photo' | 'text' | 'recipe') {
    super(
      what === 'photo'
        ? 'The AI did not find any food in this photo. Try a closer, brighter photo, or add a note about what is on the plate.'
        : what === 'text'
          ? 'The AI did not find any food in that text. Try describing it with amounts, like "200 g chicken, 1 cup rice".'
          : 'The AI did not find any ingredients. List them with amounts, like "600 g chicken, 400 g potatoes".',
    );
    this.name = 'NoFoodsFoundError';
  }
}

export interface ResolvedItems {
  items: ReviewItem[];
  /** Unmatched foods exist for which no usable estimate could be obtained. */
  estimateFailed: boolean;
}

interface CommonArgs {
  handle: AiClientHandle;
  signal?: AbortSignal;
  onStage?: (stage: PipelineStage) => void;
}

/** Wraps the search deps to notice when EVERY search failed (offline), which must not look like "no match". */
function countingDeps(): { deps: MatchDeps; failedEverywhere: () => boolean } {
  let ok = 0;
  let bad = 0;
  return {
    deps: {
      async searchFoods(query) {
        try {
          const found = await foodMatchDeps.searchFoods(query);
          ok += 1;
          return found;
        } catch (e) {
          bad += 1;
          throw e;
        }
      },
    },
    failedEverywhere: () => ok === 0 && bad > 0,
  };
}

/** Match parsed items against the database and estimate only what is missing. */
export async function resolveItems(
  args: CommonArgs & { parsed: ParsedMealItem[] },
): Promise<ResolvedItems> {
  const { handle, parsed, signal, onStage } = args;
  onStage?.('matching');
  const counting = countingDeps();
  const matched = await matchItems(parsed, counting.deps, { maxQueriesPerItem: 4, concurrency: 4 });
  if (counting.failedEverywhere()) throw new FoodSearchUnavailableError();

  let estimates: (NutrientEstimate | null)[] = matched.map(() => null);
  if (matched.some((m) => m.needsEstimate)) {
    onStage?.('estimating');
    try {
      const results = await estimateMissing({ client: handle.client, model: handle.modelId, items: matched, signal });
      estimates = results.map((r) => r.estimate);
    } catch (e) {
      if (isAbortError(e)) throw e;
      // The user can still pick a food by hand for these items.
    }
  }
  const items = buildReviewItems(matched, estimates);
  return { items, estimateFailed: items.some((i) => i.choice.kind === 'none') };
}

export interface MealResult extends ResolvedItems {
  meal: ParsedMeal;
}

export async function runPhotoPipeline(
  args: CommonArgs & { image: PreparedImage; note?: string; mealHint?: MealType },
): Promise<MealResult> {
  args.onStage?.('analyzing');
  const meal = await parseMealFromImage({
    client: args.handle.client,
    model: args.handle.modelId,
    imageBase64: args.image.base64,
    mimeType: args.image.mimeType,
    userNote: args.note,
    mealHint: args.mealHint,
    signal: args.signal,
  });
  if (meal.items.length === 0) throw new NoFoodsFoundError('photo');
  const resolved = await resolveItems({ ...args, parsed: meal.items });
  return { meal, ...resolved };
}

export async function runTextPipeline(args: CommonArgs & { text: string; mealHint?: MealType }): Promise<MealResult> {
  args.onStage?.('analyzing');
  const meal = await parseMealFromText({
    client: args.handle.client,
    model: args.handle.modelId,
    text: args.text,
    mealHint: args.mealHint,
    signal: args.signal,
  });
  if (meal.items.length === 0) throw new NoFoodsFoundError('text');
  const resolved = await resolveItems({ ...args, parsed: meal.items });
  return { meal, ...resolved };
}

export interface RecipeResult extends ResolvedItems {
  draft: RecipeDraft;
}

export async function runRecipePipeline(args: CommonArgs & { text: string }): Promise<RecipeResult> {
  args.onStage?.('analyzing');
  const draft = await draftRecipeFromText({
    client: args.handle.client,
    model: args.handle.modelId,
    text: args.text,
    signal: args.signal,
  });
  if (draft.ingredients.length === 0) throw new NoFoodsFoundError('recipe');
  const resolved = await resolveItems({ ...args, parsed: draft.ingredients });
  return { draft, ...resolved };
}

/** Maps a meal group name ("Breakfast", "Snacks", ...) to the AI's meal hint. */
export function mealTypeFromGroupName(name: string | undefined): MealType | undefined {
  const n = (name ?? '').trim().toLowerCase();
  if (n.startsWith('break')) return 'breakfast';
  if (n.startsWith('lunch')) return 'lunch';
  if (n.startsWith('dinner') || n.startsWith('supper')) return 'dinner';
  if (n.startsWith('snack')) return 'snack';
  return undefined;
}
