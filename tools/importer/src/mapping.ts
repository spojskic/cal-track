/**
 * Source nutrient id -> canonical nutrient code mapping, unit conversion and
 * per-food nutrient resolution.
 *
 * DECISION (computed nutrients): NET_CARBS_G, OMEGA3_G and OMEGA6_G are NOT
 * stored. In @cal/core they are `computed: true` ("derived from other
 * nutrients, never imported"), `deriveNutrients()` fills them at read time and
 * net carbs depend on the user's net-carb mode. Storing them would freeze one
 * interpretation into every row (and bloat the jsonb). ENERGY_KCAL, which is
 * not `computed`, is stored (with the fallback chain below) because search,
 * sorting and the quality filter need it.
 */
import {
  FDC_CONVERTED_IDS,
  NUTRIENTS,
  NUTRIENT_BY_CODE,
  NUTRIENT_BY_FDC_ID,
  estimateEnergyKcal,
  type NutrientCode,
  type NutrientMap,
  type NutrientUnit,
} from '@cal/core';
import type { EnergySource } from './types';

// ---------------------------------------------------------------------- units

/** Normalised source unit: g mg ug kcal kj iu, or whatever was given (lower case). */
export function normalizeUnit(raw: string | undefined | null): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const u = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (u === '') return undefined;
  if (u === 'g' || u === 'gram' || u === 'grams') return 'g';
  if (u === 'mg' || u === 'milligram' || u === 'milligrams') return 'mg';
  if (u === 'ug' || u === 'mcg' || u === 'microgram' || u === 'micrograms') return 'ug';
  // micro sign U+00B5, Greek mu U+03BC, or any mojibake'd leading symbol + "g".
  if (/^[^a-z0-9]+g$/.test(u)) return 'ug';
  if (u === 'kcal' || u === 'kilocalorie' || u === 'kilocalories' || u === 'kcalories') return 'kcal';
  if (u === 'kj' || u === 'kilojoule' || u === 'kilojoules') return 'kj';
  if (u === 'iu' || u === 'i.u.') return 'iu';
  return u;
}

const MASS_EXPONENT: Record<string, number> = { g: 0, mg: -3, ug: -6 };

/**
 * Multiplier converting an amount in `source` unit to the catalog `target`
 * unit, or null if it cannot be converted. An unknown source unit
 * (`undefined`) is assumed to already be in the catalog unit.
 */
export function unitFactor(source: string | undefined, target: NutrientUnit): number | null {
  if (source === undefined || source === target) return 1;
  const s = MASS_EXPONENT[source];
  const t = MASS_EXPONENT[target];
  if (s !== undefined && t !== undefined) return 10 ** (s - t);
  if (source === 'kj' && target === 'kcal') return 1 / 4.184;
  return null;
}

/** Rounds to 4 significant digits (keeps 0 as 0). */
export function roundSig(value: number, digits = 4): number {
  if (value === 0 || !Number.isFinite(value)) return value;
  return Number(value.toPrecision(digits));
}

// ---------------------------------------------------------------------- rules

/** One way to obtain a canonical nutrient from a source nutrient id/code. */
export interface MappingRule {
  /** FDC `nutrient.id` or CNF nutrient code. */
  id: number;
  code: NutrientCode;
  /** Multiplier to apply instead of the generic unit conversion (e.g. kJ -> kcal, IU -> ug). */
  factor?: number;
  /** Source unit `factor` is defined for; a known different unit makes the rule inapplicable. */
  expectUnit?: string;
}

/** Ordered rules per nutrient code (first present value wins). */
export class RuleSet {
  readonly byCode: ReadonlyMap<NutrientCode, readonly MappingRule[]>;
  /** All source ids this set can use (to filter streamed rows cheaply). */
  readonly ids: ReadonlySet<number>;
  readonly rules: readonly MappingRule[];

  constructor(rules: readonly MappingRule[]) {
    const byCode = new Map<NutrientCode, MappingRule[]>();
    const ids = new Set<number>();
    for (const rule of rules) {
      if (ids.has(rule.id)) throw new Error(`Duplicate mapping rule for source id ${rule.id}`);
      ids.add(rule.id);
      const list = byCode.get(rule.code) ?? [];
      list.push(rule);
      byCode.set(rule.code, list);
    }
    this.byCode = byCode;
    this.ids = ids;
    this.rules = rules;
  }
}

/** Explicit priority for nutrients whose FDC ids have a meaning beyond core's alt-id order. */
const FDC_PRIORITY: Partial<Record<NutrientCode, readonly number[]>> = {
  // 1008 kcal -> 2048 Atwater specific -> 2047 Atwater general (-> 1062 kJ via converted ids)
  ENERGY_KCAL: [1008, 2048, 2047],
  // 2000 "Total Sugars" (current) before 1063 "Sugars, Total" (legacy)
  SUGARS_G: [2000, 1063],
};

/** Expected unit of ids that core lists in FDC_CONVERTED_IDS. */
const CONVERTED_EXPECT_UNIT: Record<number, string> = { 1062: 'kj', 1110: 'iu' };

/**
 * Extra FDC ids the importer uses that core's catalog does not list (yet).
 * Each is applied AFTER core's own ids of the same nutrient (fallback only) and
 * is skipped automatically once core adds the same id. All verified against the
 * real FDC files of Oct 2026 (Foundation JSON, SR Legacy CSV); unit in brackets.
 *
 * Why these ids (Foundation Foods, 424 foods):
 *  - 1085 Total fat (NLEA) [g]: the only fat entry of cooking oils etc. (63 foods).
 *  - 1177 Folate, total [ug]: Foundation reports NO 1190 (DFE) at all; the foods are
 *    unfortified (no folic acid entry), where DFE equals total folate.
 *  - 2022/2023/2024/2025 PUFA 20:4c / 20:5c / 22:5 c / 22:6 c [g]: Foundation's ids for
 *    arachidonic, EPA, DPA, DHA; identical to 1271/1278/1280/1272 in every food that has
 *    both (57/57, 56/56, 58/58 foods) and present in twice as many foods.
 *  - 1050, 2033, 2034/2035: carbs by summation, AOAC 2011.25 fibre (+ soluble/insoluble).
 *  - 1086, 1176, 1096, 1102: sugar alcohols, biotin, chromium, molybdenum (catalog has no FDC id).
 * Deliberately NOT mapped although frequent: 2016/2018 (PUFA 18:2 c / 18:3 c) differ from
 * linoleic/ALA by up to 30 %, 2068 "Vitamin E" is not alpha-tocopherol, 1002 Nitrogen.
 */
export const SUPPLEMENTAL_FDC_RULES: readonly { id: number; code: NutrientCode }[] = [
  { id: 1050, code: 'CARBS_G' }, // Carbohydrate, by summation (G)
  { id: 1085, code: 'FAT_G' }, // Total fat (NLEA) (G)
  { id: 2033, code: 'FIBER_G' }, // Total dietary fiber (AOAC 2011.25) (G)
  { id: 2035, code: 'SOLUBLE_FIBER_G' }, // Soluble dietary fiber (SDFP+SDFS) (G)
  { id: 2034, code: 'INSOLUBLE_FIBER_G' }, // Insoluble dietary fiber (IDF) (G)
  { id: 1086, code: 'SUGAR_ALCOHOLS_G' }, // Total sugar alcohols (G)
  { id: 2022, code: 'ARACHIDONIC_G' }, // PUFA 20:4c (G)
  { id: 2023, code: 'EPA_G' }, // PUFA 20:5c (G)
  { id: 2024, code: 'DPA_G' }, // PUFA 22:5 c (G)
  { id: 2025, code: 'DHA_G' }, // PUFA 22:6 c (G)
  { id: 1177, code: 'FOLATE_UG' }, // Folate, total (UG) - DFE fallback, see above
  { id: 1176, code: 'B7_BIOTIN_UG' }, // Biotin (UG)
  { id: 1096, code: 'CHROMIUM_UG' }, // Chromium, Cr (UG)
  { id: 1102, code: 'MOLYBDENUM_UG' }, // Molybdenum, Mo (UG)
];

/** Builds the FDC rule set from core's catalog (+ priorities, conversions, supplements). */
export function buildFdcRules(): RuleSet {
  const rules: MappingRule[] = [];
  const used = new Set<number>();
  const add = (rule: MappingRule): void => {
    if (used.has(rule.id)) return;
    used.add(rule.id);
    rules.push(rule);
  };

  for (const n of NUTRIENTS) {
    if (n.computed) continue; // derived at read time, never stored
    const ids = [n.fdcId, ...(n.fdcAltIds ?? [])].filter((id): id is number => id !== null);
    const priority = FDC_PRIORITY[n.code] ?? [];
    for (const id of priority) if (NUTRIENT_BY_FDC_ID.get(id)?.code === n.code) add({ id, code: n.code });
    for (const id of ids) add({ id, code: n.code });
    for (const [id, conv] of FDC_CONVERTED_IDS) {
      if (conv.code !== n.code) continue;
      const expectUnit = CONVERTED_EXPECT_UNIT[id];
      add({ id, code: n.code, factor: conv.factor, ...(expectUnit ? { expectUnit } : {}) });
    }
  }
  for (const s of SUPPLEMENTAL_FDC_RULES) {
    if (NUTRIENT_BY_CODE[s.code] === undefined) continue; // catalog dropped the nutrient
    add({ id: s.id, code: s.code });
  }
  return new RuleSet(rules);
}

// ----------------------------------------------------------------- resolution

const ENERGY_SOURCE_BY_FDC_ID: Record<number, EnergySource> = {
  1008: 'kcal',
  2048: 'atwater_specific',
  2047: 'atwater_general',
  1062: 'kj',
};

/** A single known macro at least this big (g per 100 g) is enough to estimate energy. */
export const DOMINANT_MACRO_G = 90;

export interface ResolveResult {
  nutrients: NutrientMap;
  energySource: EnergySource | null;
  unitMismatches: number;
}

/**
 * Resolves a food's raw amounts (per 100 g, keyed by source id) to canonical
 * nutrients in catalog units, rounded to 4 significant digits.
 *
 * - first rule (by priority) with a usable value wins per nutrient;
 * - amounts whose unit cannot be converted are skipped (counted);
 * - a nutrient with no value stays ABSENT (unknown != 0);
 * - ENERGY_KCAL falls back to the macros (>= 2 of protein/fat/carbs known, or one >= 90 g).
 *
 * `amounts` must already be validated (finite, >= 0).
 */
export function resolveNutrients(
  amounts: ReadonlyMap<number, number>,
  rules: RuleSet,
  unitOf: (id: number) => string | undefined,
  energySourceOf: (id: number) => EnergySource | undefined = (id) => ENERGY_SOURCE_BY_FDC_ID[id],
): ResolveResult {
  const nutrients: NutrientMap = {};
  let energySource: EnergySource | null = null;
  let unitMismatches = 0;

  for (const [code, list] of rules.byCode) {
    const target = NUTRIENT_BY_CODE[code].unit;
    for (const rule of list) {
      const raw = amounts.get(rule.id);
      if (raw === undefined) continue;
      const sourceUnit = normalizeUnit(unitOf(rule.id));
      let factor: number | null;
      if (rule.factor !== undefined) {
        factor = rule.expectUnit !== undefined && sourceUnit !== undefined && sourceUnit !== rule.expectUnit
          ? null
          : rule.factor;
      } else {
        factor = unitFactor(sourceUnit, target);
      }
      if (factor === null) {
        unitMismatches += 1;
        continue;
      }
      nutrients[code] = roundSig(raw * factor);
      if (code === 'ENERGY_KCAL') energySource = energySourceOf(rule.id) ?? 'kcal';
      break;
    }
  }

  if (nutrients.ENERGY_KCAL === undefined) {
    const macros = [nutrients.PROTEIN_G, nutrients.FAT_G, nutrients.CARBS_G].filter((v): v is number => v !== undefined);
    // Two known macros, or one that is (almost) the whole food (pure oil: fat 94 g, protein and
    // carbs not reported). A lone small macro (blackberries: protein 1.5 g) says nothing.
    const usable = macros.length >= 2 || macros.some((v) => v >= DOMINANT_MACRO_G);
    if (usable) {
      const kcal = estimateEnergyKcal(nutrients, 'includes_fiber');
      if (kcal !== undefined) {
        nutrients.ENERGY_KCAL = roundSig(kcal);
        energySource = 'macros';
      }
    }
  }
  return { nutrients, energySource, unitMismatches };
}

/**
 * Parses a source amount: finite and >= 0 or null (negative / non-numeric are
 * dropped by the caller).
 */
export function validAmount(n: number | null): number | null {
  return n !== null && Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Source ids of "carbohydrate BY DIFFERENCE" (FDC 1005; CNF code 205). The value is
 * 100 - water - protein - fat - ash, so analytical noise makes it slightly negative
 * for raw meat/fish (Foundation Foods: chicken, pork, lamb, tuna: -0.06 .. -0.7 g).
 * That means "about zero", not "unknown".
 */
export const BY_DIFFERENCE_CARB_IDS: ReadonlySet<number> = new Set([1005]);
/** Negative by-difference carbs above this (g per 100 g) are noise and stored as 0. */
export const NEGATIVE_NOISE_G = -1;

/**
 * {@link validAmount} plus the by-difference rule: for a `clampable` nutrient a value in
 * (-1, 0) becomes 0 (`clamped: true`). Everything else negative stays rejected.
 */
export function sanitizeAmount(n: number | null, clampable: boolean): { value: number | null; clamped: boolean } {
  if (clampable && n !== null && n < 0 && n > NEGATIVE_NOISE_G) return { value: 0, clamped: true };
  return { value: validAmount(n), clamped: false };
}
