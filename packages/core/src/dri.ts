// VERIFY every value against the NIH ODS / NASEM DRI tables before release.
//
// Dietary Reference Intakes (DRI) seed table + target selection.
//
// All amounts are in the unit of the nutrient catalog (see nutrients.ts), e.g.
// copper in mg, fluoride in ug, water in g. Values marked `// ?` are the ones I
// am least sure about (recalled from NIH ODS fact sheets / NASEM DRI reports
// without being able to re-check them offline).
//
// Sources: NASEM DRI reports (1997-2019), NIH Office of Dietary Supplements
// fact sheets, NASEM 2019 sodium & potassium update, Dietary Guidelines for
// Americans 2020-2025 (added sugars / saturated fat <10% of energy).
//
// Age bands: 14-18, 19-30, 31-50, 51-70, 71+. Pregnancy and lactation rows
// exist for 14-18, 19-30 and 31-50. Children under 14 are NOT covered.
//
// Terminology: RDA = Recommended Dietary Allowance, AI = Adequate Intake,
// UL = Tolerable Upper Intake Level, CDRR = Chronic Disease Risk Reduction
// intake (sodium). A UL may apply only to part of the intake (`ulScope`).

import type { NutrientCode } from './nutrients';
import type { LifeStage, Sex } from './types';

/** Which kind of intake a UL applies to. */
export type UlScope = 'all' | 'supplement_only' | 'synthetic_only' | 'preformed_only';

/** A UL scope that covers only part of the intake (everything except `'all'`). */
export type ScopedUlScope = Exclude<UlScope, 'all'>;

/** True for ULs that apply to supplements / synthetic / preformed forms only, not to total intake. */
export function isScopedUlScope(scope: UlScope | undefined): scope is ScopedUlScope {
  return scope !== undefined && scope !== 'all';
}

/** One DRI row: values for a nutrient / sex / age band / life stage. */
export interface DriRow {
  nutrient: NutrientCode;
  /** 'any' = applies to both sexes. */
  sex: Sex | 'any';
  /** Inclusive lower age bound in years. */
  ageMin: number;
  /** Inclusive upper age bound in years. */
  ageMax: number;
  life: LifeStage;
  /** Recommended Dietary Allowance. */
  rda?: number;
  /** Adequate Intake (used when no RDA exists). */
  ai?: number;
  /** Tolerable Upper Intake Level (or a recommended limit, e.g. caffeine). */
  ul?: number;
  ulScope?: UlScope;
  /** Chronic Disease Risk Reduction intake (sodium). */
  cdrr?: number;
}

/** Age bands used by the table. `max` is inclusive. */
export const DRI_AGE_BANDS = [
  { label: '14-18', min: 14, max: 18 },
  { label: '19-30', min: 19, max: 30 },
  { label: '31-50', min: 31, max: 50 },
  { label: '51-70', min: 51, max: 70 },
  { label: '71+', min: 71, max: 120 },
] as const;

/** Values for the five normal age bands: 14-18, 19-30, 31-50, 51-70, 71+. */
type V5 = readonly [number, number, number, number, number];
/** Values for pregnancy / lactation: 14-18, 19-30, 31-50. */
type V3 = readonly [number, number, number];

/** Requirement (RDA or AI) per sex plus pregnancy / lactation. */
interface Req {
  m: V5;
  f: V5;
  p?: V3;
  l?: V3;
}

/** Upper limit per age band (both sexes). Pregnancy/lactation default to the first three. */
interface Lim {
  all: V5;
  p?: V3;
  l?: V3;
}

interface Spec {
  nutrient: NutrientCode;
  rda?: Req;
  ai?: Req;
  ul?: Lim;
  ulScope?: UlScope;
  cdrr?: number;
}

/** Same requirement for both sexes. */
const both = (b: V5, p?: V3, l?: V3): Req => ({ m: b, f: b, p, l });
/** Same value in every adult band. */
const flat5 = (x: number): V5 => [x, x, x, x, x];
const flat3 = (x: number): V3 => [x, x, x];

const SPECS: readonly Spec[] = [
  // ---------------------------------------------------------------- vitamins
  {
    nutrient: 'VITAMIN_A_UG', // ug RAE
    rda: { m: flat5(900), f: flat5(700), p: [750, 770, 770], l: [1200, 1300, 1300] },
    ul: { all: [2800, 3000, 3000, 3000, 3000] }, // preformed vitamin A only (retinol), not carotenoids
    ulScope: 'preformed_only',
  },
  {
    nutrient: 'VITAMIN_C_MG',
    rda: { m: [75, 90, 90, 90, 90], f: [65, 75, 75, 75, 75], p: [80, 85, 85], l: [115, 120, 120] },
    ul: { all: [1800, 2000, 2000, 2000, 2000] },
    ulScope: 'all',
  },
  {
    nutrient: 'VITAMIN_D_UG', // 15 ug = 600 IU, 20 ug = 800 IU
    rda: both([15, 15, 15, 15, 20], flat3(15), flat3(15)),
    ul: { all: flat5(100) },
    ulScope: 'all',
  },
  {
    nutrient: 'VITAMIN_E_MG', // mg alpha-tocopherol
    rda: both(flat5(15), flat3(15), flat3(19)),
    ul: { all: [800, 1000, 1000, 1000, 1000] },
    ulScope: 'supplement_only', // any supplemental form of alpha-tocopherol
  },
  {
    nutrient: 'VITAMIN_K_UG',
    ai: { m: [75, 120, 120, 120, 120], f: [75, 90, 90, 90, 90], p: [75, 90, 90], l: [75, 90, 90] },
  },
  {
    nutrient: 'B1_THIAMIN_MG',
    rda: { m: flat5(1.2), f: [1.0, 1.1, 1.1, 1.1, 1.1], p: flat3(1.4), l: flat3(1.4) },
  },
  {
    nutrient: 'B2_RIBOFLAVIN_MG',
    rda: { m: flat5(1.3), f: [1.0, 1.1, 1.1, 1.1, 1.1], p: flat3(1.4), l: flat3(1.6) },
  },
  {
    nutrient: 'B3_NIACIN_MG', // mg NE
    rda: { m: flat5(16), f: flat5(14), p: flat3(18), l: flat3(17) },
    ul: { all: [30, 35, 35, 35, 35] },
    ulScope: 'synthetic_only', // niacin from supplements / fortified foods
  },
  {
    nutrient: 'B5_PANTOTHENIC_MG',
    ai: both(flat5(5), flat3(6), flat3(7)),
  },
  {
    nutrient: 'B6_MG',
    rda: {
      m: [1.3, 1.3, 1.3, 1.7, 1.7],
      f: [1.2, 1.3, 1.3, 1.5, 1.5],
      p: flat3(1.9),
      l: flat3(2.0),
    },
    ul: { all: [80, 100, 100, 100, 100] },
    ulScope: 'all', // ? NASEM applies the UL to total intake; ODS discusses supplements
  },
  {
    nutrient: 'FOLATE_UG', // ug DFE
    rda: both(flat5(400), flat3(600), flat3(500)),
    ul: { all: [800, 1000, 1000, 1000, 1000] },
    ulScope: 'synthetic_only', // synthetic folic acid from supplements / fortified foods
  },
  {
    nutrient: 'B12_UG',
    rda: both(flat5(2.4), flat3(2.6), flat3(2.8)),
  },
  {
    nutrient: 'CHOLINE_MG',
    ai: { m: flat5(550), f: [400, 425, 425, 425, 425], p: flat3(450), l: flat3(550) },
    ul: { all: [3000, 3500, 3500, 3500, 3500] },
    ulScope: 'all',
  },
  {
    nutrient: 'B7_BIOTIN_UG',
    ai: both([25, 30, 30, 30, 30], flat3(30), flat3(35)),
  },

  // ---------------------------------------------------------------- minerals
  {
    nutrient: 'CALCIUM_MG',
    rda: {
      m: [1300, 1000, 1000, 1000, 1200],
      f: [1300, 1000, 1000, 1200, 1200],
      p: [1300, 1000, 1000],
      l: [1300, 1000, 1000],
    },
    ul: { all: [3000, 2500, 2500, 2000, 2000] },
    ulScope: 'all',
  },
  {
    nutrient: 'IRON_MG',
    rda: {
      m: [11, 8, 8, 8, 8],
      f: [15, 18, 18, 8, 8],
      p: flat3(27),
      l: [10, 9, 9],
    },
    ul: { all: flat5(45) },
    ulScope: 'all', // ? mostly relevant to supplemental iron
  },
  {
    nutrient: 'MAGNESIUM_MG',
    rda: {
      m: [410, 400, 420, 420, 420],
      f: [360, 310, 320, 320, 320],
      p: [400, 350, 360],
      l: [360, 310, 320],
    },
    ul: { all: flat5(350) },
    ulScope: 'supplement_only', // supplements / pharmacologic agents, not food
  },
  {
    nutrient: 'PHOSPHORUS_MG',
    rda: both([1250, 700, 700, 700, 700], [1250, 700, 700], [1250, 700, 700]),
    ul: { all: [4000, 4000, 4000, 4000, 3000], p: flat3(3500), l: flat3(4000) }, // ? pregnancy 3500 / lactation 4000
    ulScope: 'all',
  },
  {
    nutrient: 'POTASSIUM_MG', // NASEM 2019 AI
    ai: {
      m: [3000, 3400, 3400, 3400, 3400],
      f: [2300, 2600, 2600, 2600, 2600],
      p: [2600, 2900, 2900],
      l: [2500, 2800, 2800],
    },
  },
  {
    nutrient: 'SODIUM_MG', // NASEM 2019: AI 1500 (14-50), 1300 (51-70), 1200 (71+); CDRR 2300 for 14+
    ai: both([1500, 1500, 1500, 1300, 1200], flat3(1500), flat3(1500)), // ? 51+ values
    cdrr: 2300,
  },
  {
    nutrient: 'ZINC_MG',
    rda: { m: flat5(11), f: [9, 8, 8, 8, 8], p: [12, 11, 11], l: [13, 12, 12] },
    ul: { all: [34, 40, 40, 40, 40] },
    ulScope: 'all',
  },
  {
    nutrient: 'COPPER_MG', // RDA 890 ug (14-18), 900 ug (19+)
    rda: both([0.89, 0.9, 0.9, 0.9, 0.9], flat3(1.0), flat3(1.3)),
    ul: { all: [8, 10, 10, 10, 10] },
    ulScope: 'all',
  },
  {
    nutrient: 'MANGANESE_MG',
    ai: { m: [2.2, 2.3, 2.3, 2.3, 2.3], f: [1.6, 1.8, 1.8, 1.8, 1.8], p: flat3(2.0), l: flat3(2.6) },
    ul: { all: [9, 11, 11, 11, 11] },
    ulScope: 'all',
  },
  {
    nutrient: 'SELENIUM_UG',
    rda: both(flat5(55), flat3(60), flat3(70)),
    ul: { all: flat5(400) },
    ulScope: 'all',
  },
  {
    nutrient: 'IODINE_UG',
    rda: both(flat5(150), flat3(220), flat3(290)),
    ul: { all: [900, 1100, 1100, 1100, 1100] },
    ulScope: 'all',
  },
  {
    nutrient: 'FLUORIDE_UG', // AI 3 mg / 4 mg in the report, stored in ug
    ai: { m: [3000, 4000, 4000, 4000, 4000], f: flat5(3000), p: flat3(3000), l: flat3(3000) },
    ul: { all: flat5(10000) }, // 10 mg
    ulScope: 'all',
  },
  {
    nutrient: 'CHROMIUM_UG',
    ai: {
      m: [35, 35, 35, 30, 30],
      f: [24, 25, 25, 20, 20],
      p: [29, 30, 30], // ?
      l: [44, 45, 45], // ?
    },
  },
  {
    nutrient: 'MOLYBDENUM_UG',
    rda: both([43, 45, 45, 45, 45], flat3(50), flat3(50)),
    ul: { all: [1700, 2000, 2000, 2000, 2000] },
    ulScope: 'all',
  },

  // -------------------------------------------------------- water & fatty acids
  {
    nutrient: 'WATER_G', // ? total water (drinks + food moisture), 1 L ~ 1000 g
    ai: {
      m: [3300, 3700, 3700, 3700, 3700],
      f: [2300, 2700, 2700, 2700, 2700],
      p: flat3(3000),
      l: flat3(3800),
    },
  },
  {
    nutrient: 'LINOLEIC_G', // omega-6 AI
    ai: { m: [16, 17, 17, 14, 14], f: [11, 12, 12, 11, 11], p: flat3(13), l: flat3(13) },
  },
  {
    nutrient: 'ALA_G', // omega-3 AI
    ai: { m: flat5(1.6), f: flat5(1.1), p: flat3(1.4), l: flat3(1.3) },
  },
];

const SEXES: readonly Sex[] = ['male', 'female'];

function pick<T>(arr: readonly T[] | undefined, i: number): T | undefined {
  return arr?.[i];
}

function expandSpec(spec: Spec): DriRow[] {
  const rows: DriRow[] = [];
  const req = spec.rda ?? spec.ai;
  const field: 'rda' | 'ai' = spec.rda ? 'rda' : 'ai';

  const make = (
    sex: Sex,
    bandIdx: number,
    life: LifeStage,
    value: number | undefined,
    ul: number | undefined,
  ): void => {
    if (value === undefined && ul === undefined && spec.cdrr === undefined) return;
    const band = DRI_AGE_BANDS[bandIdx];
    if (!band) return;
    const row: DriRow = { nutrient: spec.nutrient, sex, ageMin: band.min, ageMax: band.max, life };
    if (value !== undefined) row[field] = value;
    if (ul !== undefined) {
      row.ul = ul;
      if (spec.ulScope) row.ulScope = spec.ulScope;
    }
    if (spec.cdrr !== undefined) row.cdrr = spec.cdrr;
    rows.push(row);
  };

  DRI_AGE_BANDS.forEach((_, i) => {
    for (const sex of SEXES) {
      const value = pick(sex === 'male' ? req?.m : req?.f, i);
      make(sex, i, 'normal', value, pick(spec.ul?.all, i));
    }
  });
  for (let i = 0; i < 3; i++) {
    make('female', i, 'pregnant', pick(req?.p, i), pick(spec.ul?.p ?? spec.ul?.all, i));
    make('female', i, 'lactating', pick(req?.l, i), pick(spec.ul?.l ?? spec.ul?.all, i));
  }
  return rows;
}

/** Caffeine: recommended upper limits (not DRIs; FDA / ACOG / AAP / Health Canada guidance). */
const CAFFEINE_ROWS: DriRow[] = [
  { nutrient: 'CAFFEINE_MG', sex: 'any', ageMin: 14, ageMax: 18, life: 'normal', ul: 100, ulScope: 'all' }, // ? AAP: <=100 mg/day for teens
  { nutrient: 'CAFFEINE_MG', sex: 'any', ageMin: 19, ageMax: 120, life: 'normal', ul: 400, ulScope: 'all' }, // FDA: 400 mg/day
  { nutrient: 'CAFFEINE_MG', sex: 'female', ageMin: 14, ageMax: 18, life: 'pregnant', ul: 200, ulScope: 'all' }, // ACOG: <200 mg/day
  { nutrient: 'CAFFEINE_MG', sex: 'female', ageMin: 19, ageMax: 30, life: 'pregnant', ul: 200, ulScope: 'all' },
  { nutrient: 'CAFFEINE_MG', sex: 'female', ageMin: 31, ageMax: 50, life: 'pregnant', ul: 200, ulScope: 'all' },
  { nutrient: 'CAFFEINE_MG', sex: 'female', ageMin: 14, ageMax: 18, life: 'lactating', ul: 300, ulScope: 'all' }, // ? Health Canada: 300 mg/day
  { nutrient: 'CAFFEINE_MG', sex: 'female', ageMin: 19, ageMax: 30, life: 'lactating', ul: 300, ulScope: 'all' }, // ?
  { nutrient: 'CAFFEINE_MG', sex: 'female', ageMin: 31, ageMax: 50, life: 'lactating', ul: 300, ulScope: 'all' }, // ?
];

/**
 * The raw DRI table (seed for `public.dri_values`). Natural key:
 * `(nutrient, sex, ageMin, ageMax, life)`.
 */
export const DRI_TABLE: readonly DriRow[] = [...SPECS.flatMap(expandSpec), ...CAFFEINE_ROWS];

const ROWS_BY_NUTRIENT: ReadonlyMap<NutrientCode, readonly DriRow[]> = (() => {
  const map = new Map<NutrientCode, DriRow[]>();
  for (const row of DRI_TABLE) {
    const list = map.get(row.nutrient);
    if (list) list.push(row);
    else map.set(row.nutrient, [row]);
  }
  return map;
})();

/** Smallest age for which table rows exist; younger ages are clamped to it. */
export const DRI_MIN_AGE = 14;

/**
 * Finds the DRI row for a person. Falls back from `pregnant`/`lactating` to
 * `normal` if no such row exists for the age (e.g. age 51+), and clamps ages
 * below 14 to the 14-18 band (NOT an official recommendation for children).
 */
export function findDriRow(
  nutrient: NutrientCode,
  sex: Sex,
  age: number,
  life: LifeStage = 'normal',
): DriRow | undefined {
  const rows = ROWS_BY_NUTRIENT.get(nutrient);
  if (!rows) return undefined;
  const a = Math.max(DRI_MIN_AGE, Math.floor(age));
  const match = (stage: LifeStage) =>
    rows.find(
      (r) =>
        r.life === stage && (r.sex === sex || r.sex === 'any') && a >= r.ageMin && a <= r.ageMax,
    );
  return match(life) ?? (life === 'normal' ? undefined : match('normal'));
}

/** Where a target number comes from. 'CUSTOM' = user override. */
export type TargetKind = 'RDA' | 'AI' | 'CDRR' | 'ESTIMATE' | 'CUSTOM';

/** An upper limit that applies only to one form of intake (see {@link ScopedUlScope}). */
export interface ScopedUl {
  value: number;
  scope: ScopedUlScope;
}

/**
 * A daily target for one nutrient. `min` = reach at least, `max` = stay below.
 *
 * `max` is ALWAYS a limit on total intake (food + supplements), so it is safe to colour a bar
 * red or to count as "over the limit" when it is exceeded. An upper limit that covers only
 * part of the intake (e.g. the 350 mg magnesium UL for supplements, folic acid, preformed vitamin A)
 * is kept apart in `scopedUl`: it is information, never a bound for the intake that the app tracks.
 */
export interface Target {
  min?: number;
  max?: number;
  kind: TargetKind;
  /** Upper limit that applies to supplements / synthetic / preformed forms only. Informational. */
  scopedUl?: ScopedUl;
}

/** Targets by nutrient code. */
export type Targets = Partial<Record<NutrientCode, Target>>;

/** Inputs of {@link selectTargets}. */
export interface DriProfile {
  sex: Sex;
  /** Age in whole years. */
  age: number;
  pregnant?: boolean;
  lactating?: boolean;
  weightKg: number;
  /** Daily energy target, used for energy-proportional targets (fiber, sat. fat, added sugars). */
  energyKcal: number;
}

/** Protein RDA in g per kg body weight: adults 0.8; pregnancy 1.1; lactation 1.3. */
export const PROTEIN_G_PER_KG = { normal: 0.8, pregnant: 1.1, lactating: 1.3 } as const; // ? pregnancy / lactation

/** Fiber AI: 14 g per 1000 kcal. */
export const FIBER_G_PER_1000_KCAL = 14;

/** Saturated fat and added sugars limit: 10% of energy (Dietary Guidelines). */
export const LIMIT_ENERGY_SHARE = 0.1;

/**
 * Selects daily nutrient targets for a person.
 *
 * - Table nutrients: `min` = RDA (or AI), `max` = UL when it applies to total intake; a UL that
 *   applies only to supplements / synthetic / preformed forms goes to `scopedUl` instead of `max`.
 *   Sodium returns only `max` = CDRR 2300 mg (kind 'CDRR'); caffeine returns a limit (kind 'ESTIMATE').
 * - Pregnant takes precedence over lactating if both flags are set; life-stage
 *   flags are ignored for males.
 * - `PROTEIN_G`: `min = 0.8 g/kg * weightKg` (1.1 pregnant, 1.3 lactating), kind 'RDA'.
 * - `FIBER_G`: `min = 14 g * energyKcal / 1000`, kind 'AI'.
 * - `SATURATED_FAT_G`: `max = 10% of energy / 9`, `ADDED_SUGARS_G`: `max = 10% of energy / 4`,
 *   kind 'ESTIMATE'.
 */
export function selectTargets(profile: DriProfile): Targets {
  const life: LifeStage =
    profile.sex === 'female' && profile.pregnant
      ? 'pregnant'
      : profile.sex === 'female' && profile.lactating
        ? 'lactating'
        : 'normal';
  const targets: Targets = {};

  for (const nutrient of ROWS_BY_NUTRIENT.keys()) {
    const row = findDriRow(nutrient, profile.sex, profile.age, life);
    if (!row) continue;
    if (row.cdrr !== undefined) {
      targets[nutrient] = { max: row.cdrr, kind: 'CDRR' };
      continue;
    }
    const min = row.rda ?? row.ai;
    const target: Target = {
      kind: row.rda !== undefined ? 'RDA' : row.ai !== undefined ? 'AI' : 'ESTIMATE',
    };
    if (min !== undefined) target.min = min;
    if (row.ul !== undefined) {
      if (isScopedUlScope(row.ulScope)) target.scopedUl = { value: row.ul, scope: row.ulScope };
      else target.max = row.ul;
    }
    targets[nutrient] = target;
  }

  if (Number.isFinite(profile.weightKg) && profile.weightKg > 0) {
    targets.PROTEIN_G = { min: PROTEIN_G_PER_KG[life] * profile.weightKg, kind: 'RDA' };
  }
  if (Number.isFinite(profile.energyKcal) && profile.energyKcal > 0) {
    targets.FIBER_G = { min: (FIBER_G_PER_1000_KCAL * profile.energyKcal) / 1000, kind: 'AI' };
    targets.SATURATED_FAT_G = {
      max: (LIMIT_ENERGY_SHARE * profile.energyKcal) / 9,
      kind: 'ESTIMATE',
    };
    targets.ADDED_SUGARS_G = {
      max: (LIMIT_ENERGY_SHARE * profile.energyKcal) / 4,
      kind: 'ESTIMATE',
    };
  }
  return targets;
}

/**
 * A user override for one nutrient target.
 * A number sets the bound, `null` removes it, `undefined` keeps the base value.
 */
export interface TargetOverride {
  min?: number | null;
  max?: number | null;
}

/**
 * Applies user overrides on top of base targets (returns a new object).
 *
 * - An override entry of `null` removes the nutrient's target entirely.
 * - Setting `min` or `max` to a number marks the target `kind: 'CUSTOM'`. A user `max`
 *   applies to total intake; a `scopedUl` of the base target is kept as information.
 * - Setting a bound to `null` removes that bound; a target left with neither
 *   `min` nor `max` is removed (a `scopedUl` alone is not a target).
 */
export function applyOverrides(
  base: Targets,
  overrides: Partial<Record<NutrientCode, TargetOverride | null>>,
): Targets {
  const out: Targets = { ...base };
  for (const code of Object.keys(overrides) as NutrientCode[]) {
    const ov = overrides[code];
    if (ov === undefined) continue;
    if (ov === null) {
      delete out[code];
      continue;
    }
    const current = out[code];
    const next: Target = { ...(current ?? { kind: 'CUSTOM' as const }) };
    let custom = false;

    if (ov.min === null) delete next.min;
    else if (ov.min !== undefined) {
      next.min = ov.min;
      custom = true;
    }
    if (ov.max === null) delete next.max;
    else if (ov.max !== undefined) {
      next.max = ov.max;
      custom = true;
    }
    if (custom) next.kind = 'CUSTOM';

    if (next.min === undefined && next.max === undefined) delete out[code];
    else out[code] = next;
  }
  return out;
}
