import { pickDefaultVisionModel, type ModelInfo } from '@ration/ai';

export interface ModelSelection {
  /** The model to use now (null when the catalogue is empty). */
  model: ModelInfo | null;
  /** The previously saved id that had to be replaced, or null. */
  changedFrom: string | null;
}

/**
 * Validates the saved model against the live image-capable catalogue.
 *  - empty catalogue: keep the saved id (we cannot judge it), no model
 *  - saved id still listed (and listing only contains models that accept images): keep it
 *  - otherwise: recommended default, reporting what was replaced
 */
export function resolveModelSelection(models: readonly ModelInfo[], savedId: string | null): ModelSelection {
  const vision = models.filter((m) => m.supportsImages);
  if (vision.length === 0) return { model: null, changedFrom: null };
  const saved = savedId ? vision.find((m) => m.id === savedId) : undefined;
  if (saved) return { model: saved, changedFrom: null };
  return { model: pickDefaultVisionModel(vision), changedFrom: savedId };
}

/** Looks the selected id up in the catalogue (only image-capable models are ever returned). */
export function findSelectedModel(models: readonly ModelInfo[], selectedId: string | null): ModelInfo | null {
  if (!selectedId) return null;
  return models.find((m) => m.id === selectedId) ?? null;
}

/** Picker order: selected first, then the recommended default, then structured-output models by price, then name. */
export function sortModelsForPicker(
  models: readonly ModelInfo[],
  selectedId: string | null,
  recommendedId: string | null,
): ModelInfo[] {
  const rank = (m: ModelInfo): number => (m.id === selectedId ? 0 : m.id === recommendedId ? 1 : 2);
  return [...models].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    if (a.supportsStructuredOutputs !== b.supportsStructuredOutputs) return a.supportsStructuredOutputs ? -1 : 1;
    if (a.isFree !== b.isFree) return a.isFree ? 1 : -1; // free models are heavily rate limited: list them later
    const pa = a.promptPricePerM ?? Number.POSITIVE_INFINITY;
    const pb = b.promptPricePerM ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });
}

/** Accent-insensitive "contains all words" filter over name + id. */
export function filterModels(models: readonly ModelInfo[], query: string): ModelInfo[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...models];
  return models.filter((m) => {
    const hay = fold(`${m.name} ${m.id}`);
    return words.every((w) => hay.includes(w));
  });
}

function fold(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
