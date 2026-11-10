// Pure (no React Native imports): the wording and colour rule of the right-aligned source label on food rows.
import type { FoodKind, FoodSource } from '@/data/foods';
import type { ThemeColors } from '@/theme/colors';

export interface SourceInfo {
  /** Short name shown on the source badge on the food detail page. */
  label: string;
  /** Accessible, spelled-out source name. */
  full: string;
}

export const SOURCES: Record<FoodSource, SourceInfo> = {
  fdc_foundation: { label: 'USDA', full: 'USDA FoodData Central' },
  fdc_sr_legacy: { label: 'USDA', full: 'USDA FoodData Central' },
  fdc_fndds: { label: 'USDA', full: 'USDA FoodData Central' },
  fdc_branded: { label: 'USDA', full: 'USDA FoodData Central (branded)' },
  cnf: { label: 'CNF', full: 'Canadian Nutrient File' },
  cofid: { label: 'CoFID', full: 'UK Composition of Foods' },
  off: { label: 'OFF', full: 'Open Food Facts' },
  custom: { label: 'Custom', full: 'Custom food' },
  recipe: { label: 'Recipe', full: 'Recipe' },
  ai_estimate: { label: 'AI', full: 'AI estimate' },
};

export function sourceInfo(source: FoodSource): SourceInfo {
  return SOURCES[source];
}

/** What kind of thing the row is: decides the colour of its source label. */
export type SourceTone = 'custom' | 'recipe' | 'ai' | 'database';

export interface SourceLabelInfo {
  /** The visible label ("Custom Food", "USDA"). */
  text: string;
  /** Accessible, spelled-out name ("Custom food", "USDA FoodData Central"). */
  full: string;
  tone: SourceTone;
}

/** Label of a saved meal in the Foods tab (a saved meal is not a food row, so it has no FoodSource). */
export const SAVED_MEAL_LABEL: SourceLabelInfo = { text: 'Saved Meal', full: 'Saved meal', tone: 'recipe' };

/**
 * The source label of a food row. Own foods and recipes are named for what they are, everything else shows the
 * database it came from. `kind` wins over a database `source` only for own foods ('custom' / 'recipe' / 'ai_estimate').
 */
export function foodSourceLabel(source: FoodSource, kind?: FoodKind | null): SourceLabelInfo {
  if (source === 'recipe' || kind === 'recipe') return { text: 'Custom Recipe', full: 'Custom recipe', tone: 'recipe' };
  if (source === 'custom' || kind === 'custom') return { text: 'Custom Food', full: 'Custom food', tone: 'custom' };
  if (source === 'ai_estimate' || kind === 'ai_estimate') return { text: 'AI Estimate', full: 'AI estimate', tone: 'ai' };
  const info = SOURCES[source];
  return { text: info.label, full: info.full, tone: 'database' };
}

/** Custom food = primary colour, recipe / saved meal = teal (the carbs colour), AI estimate = purple, database = muted. */
export function sourceToneColor(
  tone: SourceTone,
  colors: Pick<ThemeColors, 'primary' | 'carbs' | 'fat' | 'textMuted'>,
): string {
  switch (tone) {
    case 'custom':
      return colors.primary;
    case 'recipe':
      return colors.carbs;
    case 'ai':
      return colors.fat;
    case 'database':
      return colors.textMuted;
  }
}
