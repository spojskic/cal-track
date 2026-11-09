/**
 * Dependency-injected AI pipelines. Nothing here touches a database or the
 * network directly: LLM calls go through the injected OpenRouter client and
 * food lookups through `deps.searchFoods`.
 *
 * Flow in the app:
 *   parseMealFromText / parseMealFromImage  -> ParsedMeal (foods + grams only)
 *   matchItems(items, { searchFoods })      -> MatchedItem[] (nutrients come from OUR database)
 *   estimateMissing({ items: matched })     -> AI nutrient estimate ONLY for unmatched foods
 *                                              (the UI must flag these as "AI estimate")
 */

import { OpenRouterError } from './errors';
import { assertReasonableImageSize } from './image';
import type { OpenRouterClient } from './openrouter';
import {
  NUTRIENT_ESTIMATE_SYSTEM_PROMPT,
  PHOTO_LOG_SYSTEM_PROMPT,
  RECIPE_DRAFT_SYSTEM_PROMPT,
  TEXT_LOG_SYSTEM_PROMPT,
  buildEstimateUserContent,
  wrapUntrusted,
} from './prompts';
import {
  NUTRIENT_CODE_PATTERN,
  NutrientEstimateWireSchema,
  ParsedMealSchema,
  RecipeDraftSchema,
  type FoodCandidate,
  type MatchedItem,
  type MealType,
  type NutrientEstimate,
  type ParsedMeal,
  type ParsedMealItem,
  type RecipeDraft,
} from './schemas';
import { normalizeText, stripQuantitiesPreserve, textSimilarity } from './similarity';

export type { FoodCandidate, MatchedItem } from './schemas';

type JsonClient = Pick<OpenRouterClient, 'chatJson'>;

interface BaseArgs {
  client: JsonClient;
  /** Primary model id (must support image input for photo parsing). */
  model: string;
  /** Optional fallback models, tried in order by OpenRouter. */
  fallbackModels?: string[];
  signal?: AbortSignal;
  maxTokens?: number;
}

const MAX_TEXT_CHARS = 4000;

// ---------------------------------------------------------------------------
// normalisation of model output
// ---------------------------------------------------------------------------

function cleanString(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function normalizeParsedItem(item: ParsedMealItem): ParsedMealItem {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of [...item.searchTerms, item.name]) {
    const t = raw.trim().replace(/\s+/g, ' ');
    const key = t.toLowerCase();
    if (t && !seen.has(key)) {
      seen.add(key);
      terms.push(t);
    }
    if (terms.length >= 6) break;
  }
  const grams = round1(item.grams);
  const low = item.gramsLow !== undefined && item.gramsLow <= grams ? round1(item.gramsLow) : undefined;
  const high = item.gramsHigh !== undefined && item.gramsHigh >= grams ? round1(item.gramsHigh) : undefined;
  return {
    name: item.name.trim(),
    searchTerms: terms,
    originalText: cleanString(item.originalText),
    grams,
    gramsLow: low,
    gramsHigh: high,
    preparation: cleanString(item.preparation),
    brand: cleanString(item.brand),
    confidence: Math.min(1, Math.max(0, item.confidence)),
  };
}

export function normalizeParsedMeal(meal: ParsedMeal): ParsedMeal {
  return {
    items: meal.items.map(normalizeParsedItem),
    notes: cleanString(meal.notes),
    mealGuess: meal.mealGuess,
  };
}

function normalizeRecipe(recipe: RecipeDraft): RecipeDraft {
  return {
    name: recipe.name.trim(),
    servings: recipe.servings,
    finalWeightG: recipe.finalWeightG,
    ingredients: recipe.ingredients.map(normalizeParsedItem),
    instructions: cleanString(recipe.instructions),
  };
}

function requireText(text: string, what: string): string {
  const t = text.trim();
  if (!t) {
    throw new OpenRouterError({
      kind: 'bad_request',
      message: `${what} is empty`,
      userMessage: 'Type something first.',
    });
  }
  return t;
}

// ---------------------------------------------------------------------------
// LLM parsing pipelines
// ---------------------------------------------------------------------------

export interface ParseMealFromTextArgs extends BaseArgs {
  text: string;
  mealHint?: MealType;
}

export async function parseMealFromText(args: ParseMealFromTextArgs): Promise<ParsedMeal> {
  const text = requireText(args.text, 'Meal text');
  const hint = args.mealHint ? `Meal hint from the app: ${args.mealHint}.\n` : '';
  const meal = await args.client.chatJson({
    model: args.model,
    models: args.fallbackModels,
    schema: ParsedMealSchema,
    jsonSchemaName: 'parsed_meal',
    maxTokens: args.maxTokens ?? 1500,
    signal: args.signal,
    messages: [
      { role: 'system', content: TEXT_LOG_SYSTEM_PROMPT },
      { role: 'user', content: `${hint}${wrapUntrusted('user_text', text, MAX_TEXT_CHARS)}` },
    ],
  });
  return normalizeParsedMeal(meal);
}

export interface ParseMealFromImageArgs extends BaseArgs {
  /** Base64 JPEG/PNG/WebP, already resized (~1024 px) by the app. A data: prefix is tolerated. */
  imageBase64: string;
  mimeType: string;
  userNote?: string;
  mealHint?: MealType;
}

export async function parseMealFromImage(args: ParseMealFromImageArgs): Promise<ParsedMeal> {
  assertReasonableImageSize(args.imageBase64);
  const note = args.userNote?.trim();
  const hint = args.mealHint ? `Meal hint from the app: ${args.mealHint}.\n` : '';
  const text =
    `${hint}Identify the foods in the attached photo.` +
    (note ? `\n${wrapUntrusted('user_note', note, 500)}` : '');
  const meal = await args.client.chatJson({
    model: args.model,
    models: args.fallbackModels,
    schema: ParsedMealSchema,
    jsonSchemaName: 'parsed_meal',
    maxTokens: args.maxTokens ?? 1500,
    signal: args.signal,
    images: [{ base64: args.imageBase64, mimeType: args.mimeType }],
    messages: [
      { role: 'system', content: PHOTO_LOG_SYSTEM_PROMPT },
      { role: 'user', content: text },
    ],
  });
  return normalizeParsedMeal(meal);
}

export interface DraftRecipeArgs extends BaseArgs {
  text: string;
}

export async function draftRecipeFromText(args: DraftRecipeArgs): Promise<RecipeDraft> {
  const text = requireText(args.text, 'Recipe text');
  const recipe = await args.client.chatJson({
    model: args.model,
    models: args.fallbackModels,
    schema: RecipeDraftSchema,
    jsonSchemaName: 'recipe_draft',
    maxTokens: args.maxTokens ?? 2500,
    signal: args.signal,
    messages: [
      { role: 'system', content: RECIPE_DRAFT_SYSTEM_PROMPT },
      { role: 'user', content: wrapUntrusted('user_text', text, 8000) },
    ],
  });
  return normalizeRecipe(recipe);
}

// ---------------------------------------------------------------------------
// matching against the app's food database
// ---------------------------------------------------------------------------

export interface MatchDeps {
  /** Must search the user's own foods too. Diacritic handling happens server side; we send original text. */
  searchFoods(query: string): Promise<FoodCandidate[]>;
}

/** Quality weight per `candidate.source`. Unknown sources get `defaultSourceWeight`. Edit as sources are added. */
export const DEFAULT_SOURCE_WEIGHTS: Readonly<Record<string, number>> = {
  user: 1,
  custom: 1,
  usda: 0.95,
  cnf: 0.92,
  cofid: 0.92,
  off: 0.75,
  ai: 0.4,
};

export interface MatchOptions {
  /** Minimum final score for a candidate to be accepted as `best`. Default 0.6. */
  threshold?: number;
  /** Maximum parallel searchFoods calls. Default 4. */
  concurrency?: number;
  /** Max alternatives per item. Default 4. */
  maxAlternatives?: number;
  /** Alternatives below this score are not offered. Default 0.2. */
  alternativeFloor?: number;
  /** Max distinct queries per item. Default 6. */
  maxQueriesPerItem?: number;
  sourceWeights?: Record<string, number>;
  defaultSourceWeight?: number;
  /** Called when one search fails; the failure only drops that query's candidates. */
  onSearchError?: (error: unknown, query: string) => void;
}

interface ScoredCandidate {
  candidate: FoodCandidate;
  score: number;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Phrases to search with / compare against, in priority order, de-duplicated. */
export function queriesForItem(item: ParsedMealItem, max = 6): string[] {
  const raw: string[] = [];
  if (item.originalText) {
    const stripped = stripQuantitiesPreserve(item.originalText);
    if (stripped) raw.push(stripped);
  }
  raw.push(item.name);
  raw.push(...item.searchTerms);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of raw) {
    const trimmed = q.trim();
    const key = normalizeText(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

export function scoreCandidate(
  candidate: FoodCandidate,
  item: ParsedMealItem,
  phrases: string[],
  opts: Pick<MatchOptions, 'sourceWeights' | 'defaultSourceWeight'> = {},
): number {
  let sim = 0;
  const brandedName = candidate.brand ? `${candidate.brand} ${candidate.name}` : undefined;
  phrases.forEach((phrase, i) => {
    // Earlier phrases (original wording, then the model's primary name) count slightly more.
    const priority = 1 - 0.03 * i;
    let s = textSimilarity(phrase, candidate.name);
    if (brandedName) s = Math.max(s, textSimilarity(phrase, brandedName));
    sim = Math.max(sim, s * priority);
  });
  if (sim <= 0) return 0;

  const weights = { ...DEFAULT_SOURCE_WEIGHTS, ...(opts.sourceWeights ?? {}) };
  const sourceWeight = weights[candidate.source] ?? opts.defaultSourceWeight ?? 0.8;
  const completeness = clamp01(Number.isFinite(candidate.completeness) ? candidate.completeness : 0);
  // Quality factors are deliberately mild: they re-rank near-equal names, they do not rescue a poor name match.
  let score = sim * (0.8 + 0.2 * sourceWeight) * (0.85 + 0.15 * completeness);

  // Boosts only apply once the name is a plausible match, so a frequently used unrelated food cannot win.
  if (sim >= 0.3) {
    if (candidate.isUserFood) score += 0.08;
    const usage = candidate.usageCount ?? 0;
    if (usage > 0) score += Math.min(0.07, Math.log10(1 + usage) * 0.035);
    if (item.brand && candidate.brand && normalizeText(candidate.brand).includes(normalizeText(item.brand))) {
      score += 0.05;
    }
  }
  return clamp01(score);
}

function compareScored(a: ScoredCandidate, b: ScoredCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  const ua = a.candidate.isUserFood ? 1 : 0;
  const ub = b.candidate.isUserFood ? 1 : 0;
  if (ub !== ua) return ub - ua;
  const uc = (b.candidate.usageCount ?? 0) - (a.candidate.usageCount ?? 0);
  if (uc !== 0) return uc;
  const comp = b.candidate.completeness - a.candidate.completeness;
  if (comp !== 0) return comp;
  if (a.candidate.name !== b.candidate.name) return a.candidate.name < b.candidate.name ? -1 : 1;
  return a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0;
}

/**
 * For every parsed item: searches by the user's original wording (finds Bosnian custom foods)
 * AND by each English search term, merges, ranks and picks the best candidate.
 */
export async function matchItems(
  items: ParsedMealItem[],
  deps: MatchDeps,
  opts: MatchOptions = {},
): Promise<MatchedItem[]> {
  const threshold = opts.threshold ?? 0.6;
  const maxAlternatives = opts.maxAlternatives ?? 4;
  const floor = opts.alternativeFloor ?? 0.2;

  const itemQueries = items.map((item) => queriesForItem(item, opts.maxQueriesPerItem ?? 6));

  // One search per distinct (normalised) query across all items.
  const uniqueQueries = new Map<string, string>();
  for (const qs of itemQueries) {
    for (const q of qs) {
      const key = normalizeText(q);
      if (!uniqueQueries.has(key)) uniqueQueries.set(key, q);
    }
  }
  const entries = [...uniqueQueries.entries()];
  const resultsByKey = new Map<string, FoodCandidate[]>();
  await mapLimit(entries, opts.concurrency ?? 4, async ([key, query]) => {
    try {
      const found = await deps.searchFoods(query);
      resultsByKey.set(key, Array.isArray(found) ? found : []);
    } catch (error) {
      opts.onSearchError?.(error, query);
      resultsByKey.set(key, []);
    }
  });

  return items.map((item, idx): MatchedItem => {
    const queries = itemQueries[idx] ?? [];
    const merged = new Map<string, FoodCandidate>();
    for (const q of queries) {
      for (const cand of resultsByKey.get(normalizeText(q)) ?? []) {
        if (!merged.has(cand.id)) merged.set(cand.id, cand);
      }
    }
    const ranked: ScoredCandidate[] = [...merged.values()]
      .map((candidate) => ({ candidate, score: scoreCandidate(candidate, item, queries, opts) }))
      .filter((s) => s.score > 0)
      .sort(compareScored);

    const top = ranked[0];
    const accepted = top !== undefined && top.score >= threshold;
    const rest = (accepted ? ranked.slice(1) : ranked).filter((s) => s.score >= floor);
    return {
      item,
      best: accepted && top ? top.candidate : null,
      alternatives: rest.slice(0, maxAlternatives).map((s) => s.candidate),
      matchScore: top ? Math.round(top.score * 1000) / 1000 : 0,
      needsEstimate: !accepted,
    };
  });
}

// ---------------------------------------------------------------------------
// AI nutrient estimate fallback (only for unmatched foods)
// ---------------------------------------------------------------------------

export interface EstimateMissingArgs extends BaseArgs {
  /** MatchedItems (only those with needsEstimate are sent) or raw ParsedMealItems (all sent). */
  items: Array<MatchedItem | ParsedMealItem>;
  /** Foods per LLM call. Default 12. */
  batchSize?: number;
}

export interface EstimateResult {
  item: ParsedMealItem;
  /** null = not requested (already matched) or the model gave no usable numbers. */
  estimate: NutrientEstimate | null;
  /** Always true when `estimate` is set: the UI must label it "AI estimate". */
  isAiEstimate: boolean;
}

function isMatched(x: MatchedItem | ParsedMealItem): x is MatchedItem {
  return 'needsEstimate' in x && 'item' in x;
}

const PRIMARY_CODES = ['ENERGY_KCAL', 'PROTEIN_G', 'CARBS_G', 'FAT_G'] as const;

/** Validates / cleans one model estimate. Returns null if unusable. */
export function sanitizeNutrientEstimate(
  nutrients: Array<{ code: string; per100g: number }>,
  confidence: number,
): NutrientEstimate | null {
  const per100g: Record<string, number> = {};
  for (const n of nutrients) {
    const code = n.code.trim().toUpperCase();
    if (!NUTRIENT_CODE_PATTERN.test(code)) continue;
    if (!Number.isFinite(n.per100g) || n.per100g < 0) continue;
    let max = Number.POSITIVE_INFINITY;
    if (code === 'ENERGY_KCAL') max = 900;
    else if (code.endsWith('_G')) max = 100;
    else if (code.endsWith('_MG')) max = 100_000;
    else if (code.endsWith('_UG')) max = 1_000_000;
    if (n.per100g > max) continue;
    if (!(code in per100g)) per100g[code] = Math.round(n.per100g * 100) / 100;
  }
  for (const code of PRIMARY_CODES) if (per100g[code] === undefined) return null;
  const protein = per100g.PROTEIN_G as number;
  const carbs = per100g.CARBS_G as number;
  const fat = per100g.FAT_G as number;
  if (protein + carbs + fat > 105) return null;
  if (per100g.SUGARS_G !== undefined && per100g.SUGARS_G > carbs) per100g.SUGARS_G = carbs;

  let conf = clamp01(confidence);
  const atwater = 4 * protein + 4 * carbs + 9 * fat;
  const kcal = per100g.ENERGY_KCAL as number;
  if (Math.abs(kcal - atwater) > 40 && Math.abs(kcal - atwater) > 0.35 * Math.max(kcal, atwater)) {
    conf = Math.min(conf, 0.3); // numbers disagree with each other
  }
  return { per100g, confidence: Math.round(conf * 100) / 100 };
}

/**
 * Asks the model for typical per-100 g nutrients, ONLY for items with no database match.
 * Results are aligned 1:1 with `items`; callers must flag them as AI estimates.
 */
export async function estimateMissing(args: EstimateMissingArgs): Promise<EstimateResult[]> {
  const results: EstimateResult[] = args.items.map((x) => ({
    item: isMatched(x) ? x.item : x,
    estimate: null,
    isAiEstimate: true,
  }));
  const todo: number[] = [];
  args.items.forEach((x, i) => {
    if (!isMatched(x) || x.needsEstimate) todo.push(i);
  });

  const batchSize = Math.max(1, args.batchSize ?? 12);
  for (let start = 0; start < todo.length; start += batchSize) {
    const batch = todo.slice(start, start + batchSize);
    const content = buildEstimateUserContent(
      batch.map((origIdx, k) => {
        const it = (results[origIdx] as EstimateResult).item;
        return { index: k, name: it.name, originalText: it.originalText, preparation: it.preparation };
      }),
    );
    const wire = await args.client.chatJson({
      model: args.model,
      models: args.fallbackModels,
      schema: NutrientEstimateWireSchema,
      jsonSchemaName: 'nutrient_estimates',
      temperature: 0.1,
      maxTokens: args.maxTokens ?? 2500,
      signal: args.signal,
      messages: [
        { role: 'system', content: NUTRIENT_ESTIMATE_SYSTEM_PROMPT },
        { role: 'user', content },
      ],
    });
    const seen = new Set<number>();
    for (const est of wire.estimates) {
      const origIdx = batch[est.index];
      if (origIdx === undefined || seen.has(est.index)) continue;
      seen.add(est.index);
      const cleaned = sanitizeNutrientEstimate(est.nutrients, est.confidence);
      if (cleaned) (results[origIdx] as EstimateResult).estimate = cleaned;
    }
  }
  return results;
}
