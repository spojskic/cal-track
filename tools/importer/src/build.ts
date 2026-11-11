/** Turns one parsed source food into an {@link ImportFood} (or drops it, counting why). */
import { completeness } from '@ration/core';
import { resolveNutrients, type RuleSet } from './mapping';
import { finalizePortions, type PortionCandidate } from './portions';
import { EXCLUDED_CATEGORIES, cleanCategory, cleanName, qualityCheck } from './quality';
import type { DatasetStats, EnergySource, ImportFood, ImportSource } from './types';

export interface AssembleInput {
  source: ImportSource;
  sourceId: string;
  rawName: string;
  rawCategory: string | null;
  /** Raw per-100 g amounts keyed by source nutrient id/code (validated: finite, >= 0). */
  amounts: ReadonlyMap<number, number>;
  rules: RuleSet;
  unitOf: (id: number) => string | undefined;
  /** Maps a rule id to the energy provenance label (FDC ids / CNF codes differ). */
  energySourceOf?: (id: number) => EnergySource | undefined;
  portions: readonly PortionCandidate[];
}

export function assembleFood(input: AssembleInput, stats: DatasetStats): ImportFood | null {
  const name = cleanName(input.rawName);
  if (name === '') {
    stats.dropped.no_name += 1;
    return null;
  }
  const category = cleanCategory(input.rawCategory);
  if (category !== null && EXCLUDED_CATEGORIES.has(category.toLowerCase())) {
    stats.dropped.excluded_category += 1;
    return null;
  }

  const resolved = resolveNutrients(input.amounts, input.rules, input.unitOf, input.energySourceOf);
  stats.unitMismatches += resolved.unitMismatches;

  const reason = qualityCheck(resolved.nutrients);
  if (reason !== null) {
    stats.dropped[reason] += 1;
    return null;
  }

  const { portions, dropped } = finalizePortions(input.portions);
  stats.portionsDropped += dropped;
  stats.portionsKept += portions.length;
  stats.kept += 1;
  stats.nutrientEntries += Object.keys(resolved.nutrients).length;
  if (resolved.energySource !== null) stats.energySources[resolved.energySource] += 1;

  return {
    source: input.source,
    sourceId: input.sourceId,
    kind: 'generic',
    name,
    category,
    nutrients: resolved.nutrients,
    completeness: Number(completeness(resolved.nutrients).toFixed(4)),
    carbBasis: 'includes_fiber',
    portions,
  };
}
