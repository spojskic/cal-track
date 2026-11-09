import type { UnitSystem } from './types';

// ---------------------------------------------------------------- constants

/** Grams per avoirdupois ounce (exact). */
export const G_PER_OZ = 28.349523125;
/** Grams per avoirdupois pound (exact). */
export const G_PER_LB = 453.59237;
/** Pounds per stone. */
export const LB_PER_STONE = 14;
/** Millilitres per US fluid ounce (exact). */
export const ML_PER_FL_OZ = 29.5735295625;
/** Millilitres per US customary cup as used on nutrition labels. */
export const ML_PER_CUP = 240;
/** Millilitres per tablespoon (nutrition-label convention). */
export const ML_PER_TBSP = 15;
/** Millilitres per teaspoon (nutrition-label convention). */
export const ML_PER_TSP = 5;
/** Centimetres per inch (exact). */
export const CM_PER_IN = 2.54;
/** Inches per foot. */
export const IN_PER_FT = 12;

// -------------------------------------------------------------- mass

/** Units accepted by {@link convertMass}. */
export type MassUnit = 'g' | 'kg' | 'oz' | 'lb' | 'st';

const GRAMS_PER_MASS_UNIT: Record<MassUnit, number> = {
  g: 1,
  kg: 1000,
  oz: G_PER_OZ,
  lb: G_PER_LB,
  st: G_PER_LB * LB_PER_STONE,
};

/** Converts a mass between g, kg, oz, lb and stone. */
export function convertMass(value: number, from: MassUnit, to: MassUnit): number {
  return (value * GRAMS_PER_MASS_UNIT[from]) / GRAMS_PER_MASS_UNIT[to];
}

/** Kilograms to pounds: `kg / 0.45359237`. */
export const kgToLb = (kg: number): number => convertMass(kg, 'kg', 'lb');
/** Pounds to kilograms: `lb * 0.45359237`. */
export const lbToKg = (lb: number): number => convertMass(lb, 'lb', 'kg');
/** Grams to ounces. */
export const gToOz = (g: number): number => convertMass(g, 'g', 'oz');
/** Ounces to grams. */
export const ozToG = (oz: number): number => convertMass(oz, 'oz', 'g');
/** Kilograms to stone (decimal). */
export const kgToStone = (kg: number): number => convertMass(kg, 'kg', 'st');
/** Stone (decimal) to kilograms. */
export const stoneToKg = (st: number): number => convertMass(st, 'st', 'kg');

// ------------------------------------------------------------ volume

/** Units accepted by {@link convertVolume}. */
export type VolumeUnit = 'ml' | 'l' | 'fl_oz' | 'cup' | 'tbsp' | 'tsp';

const ML_PER_VOLUME_UNIT: Record<VolumeUnit, number> = {
  ml: 1,
  l: 1000,
  fl_oz: ML_PER_FL_OZ,
  cup: ML_PER_CUP,
  tbsp: ML_PER_TBSP,
  tsp: ML_PER_TSP,
};

/**
 * Converts a volume between ml, l, US fl oz, cup (240 ml), tbsp (15 ml) and
 * tsp (5 ml). Cup/tbsp/tsp use the nutrition-label convention, fl oz is the
 * exact US customary ounce.
 */
export function convertVolume(value: number, from: VolumeUnit, to: VolumeUnit): number {
  return (value * ML_PER_VOLUME_UNIT[from]) / ML_PER_VOLUME_UNIT[to];
}

/** Millilitres to US fluid ounces. */
export const mlToFlOz = (ml: number): number => convertVolume(ml, 'ml', 'fl_oz');
/** US fluid ounces to millilitres. */
export const flOzToMl = (flOz: number): number => convertVolume(flOz, 'fl_oz', 'ml');

/**
 * Mass of a volume of food: `grams = ml * density (g/ml)`.
 *
 * @param ml            volume in millilitres
 * @param densityGPerMl density in g per ml (water = 1.0)
 */
export function gramsFromVolume(ml: number, densityGPerMl: number): number {
  return ml * densityGPerMl;
}

/** Inverse of {@link gramsFromVolume}: `ml = grams / density`. */
export function volumeFromGrams(grams: number, densityGPerMl: number): number {
  if (densityGPerMl <= 0) throw new RangeError('density must be positive');
  return grams / densityGPerMl;
}

// ------------------------------------------------------------ length

/** Units accepted by {@link convertLength}. */
export type LengthUnit = 'cm' | 'm' | 'in' | 'ft';

const CM_PER_LENGTH_UNIT: Record<LengthUnit, number> = {
  cm: 1,
  m: 100,
  in: CM_PER_IN,
  ft: CM_PER_IN * IN_PER_FT,
};

/** Converts a length between cm, m, in and ft. */
export function convertLength(value: number, from: LengthUnit, to: LengthUnit): number {
  return (value * CM_PER_LENGTH_UNIT[from]) / CM_PER_LENGTH_UNIT[to];
}

/** Centimetres to decimal inches. */
export const cmToIn = (cm: number): number => convertLength(cm, 'cm', 'in');
/** Inches to centimetres. */
export const inToCm = (inches: number): number => convertLength(inches, 'in', 'cm');

/** Feet + inches to centimetres: `(ft * 12 + in) * 2.54`. */
export function ftInToCm(feet: number, inches: number): number {
  return (feet * IN_PER_FT + inches) * CM_PER_IN;
}

/**
 * Centimetres to feet and inches. Total inches are rounded to the nearest
 * whole inch first, so 12 inches always carries into a foot.
 */
export function cmToFtIn(cm: number): { feet: number; inches: number } {
  const totalInches = Math.round(cm / CM_PER_IN);
  return { feet: Math.floor(totalInches / IN_PER_FT), inches: totalInches % IN_PER_FT };
}

// ------------------------------------------------------- formatting

/** Rounds to `maxDecimals` and drops trailing zeros ("80", "80.5"). */
function trimNumber(value: number, maxDecimals: number): string {
  const rounded = Number(value.toFixed(maxDecimals));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/**
 * Formats a body weight stored in kg.
 * metric: `"80 kg"` / `"80.5 kg"` (max 1 decimal); imperial: `"176.4 lb"`.
 */
export function formatWeight(kg: number, system: UnitSystem): string {
  return system === 'metric' ? `${trimNumber(kg, 1)} kg` : `${trimNumber(kgToLb(kg), 1)} lb`;
}

/**
 * Formats a height stored in cm.
 * metric: `"180 cm"` (max 1 decimal); imperial: `5'11"` (rounded to whole inches).
 */
export function formatHeight(cm: number, system: UnitSystem): string {
  if (system === 'metric') return `${trimNumber(cm, 1)} cm`;
  const { feet, inches } = cmToFtIn(cm);
  return `${feet}'${inches}"`;
}

/** Formats a food mass in grams: `"150 g"` (metric) or `"5.3 oz"` (imperial). */
export function formatFoodMass(grams: number, system: UnitSystem): string {
  return system === 'metric' ? `${trimNumber(grams, 1)} g` : `${trimNumber(gToOz(grams), 1)} oz`;
}

// ---------------------------------------------------------- parsing

/**
 * Parses a user-typed number. Accepts decimal point or comma ("1,5"),
 * simple fractions ("1/2") and mixed numbers ("1 1/2"). Returns `null` if the
 * text is not a finite non-negative number.
 */
export function parseNumber(text: string): number | null {
  const s = text.trim().replace(',', '.');
  if (s === '') return null;
  const mixed = /^(\d+)\s+(\d+)\s*\/\s*(\d+)$/.exec(s);
  if (mixed) {
    const [, whole, num, den] = mixed;
    if (Number(den) === 0) return null;
    return Number(whole) + Number(num) / Number(den);
  }
  const frac = /^(\d+)\s*\/\s*(\d+)$/.exec(s);
  if (frac) {
    const [, num, den] = frac;
    if (Number(den) === 0) return null;
    return Number(num) / Number(den);
  }
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  return Number(s);
}

const WEIGHT_UNIT_ALIASES: Record<string, MassUnit> = {
  g: 'g',
  gram: 'g',
  grams: 'g',
  kg: 'kg',
  kgs: 'kg',
  kilo: 'kg',
  kilos: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  oz: 'oz',
  ounce: 'oz',
  ounces: 'oz',
  lb: 'lb',
  lbs: 'lb',
  pound: 'lb',
  pounds: 'lb',
  st: 'st',
  stone: 'st',
  stones: 'st',
};

/**
 * Parses a body weight typed by a user and returns kilograms (or `null`).
 *
 * Accepted: `"80"` (interpreted in `defaultSystem`), `"80 kg"`, `"176.4lb"`,
 * `"12 st 4 lb"`, `"12st"`. Unit words are case-insensitive.
 */
export function parseWeightKg(text: string, defaultSystem: UnitSystem = 'metric'): number | null {
  const s = text.trim().toLowerCase();
  if (s === '') return null;

  const stLb = /^(\d+(?:[.,]\d+)?)\s*(?:st|stone|stones)\s*(?:(\d+(?:[.,]\d+)?)\s*(?:lb|lbs|pounds?)?)?$/.exec(s);
  if (stLb) {
    const st = parseNumber(stLb[1] ?? '');
    const lb = stLb[2] === undefined ? 0 : parseNumber(stLb[2]);
    if (st === null || lb === null) return null;
    return stoneToKg(st) + lbToKg(lb);
  }

  const m = /^([\d.,]+)\s*([a-z]*)$/.exec(s);
  if (!m) return null;
  const value = parseNumber(m[1] ?? '');
  if (value === null) return null;
  const unitText = m[2] ?? '';
  if (unitText === '') return defaultSystem === 'metric' ? value : lbToKg(value);
  const unit = WEIGHT_UNIT_ALIASES[unitText];
  if (!unit) return null;
  return convertMass(value, unit, 'kg');
}

/**
 * Parses a height typed by a user and returns centimetres (or `null`).
 *
 * Accepted: `"180"` / `"180 cm"`, `"1.8 m"`, `"71 in"`, `5'11"`, `5' 11`,
 * `"5 ft 11 in"`, `"6ft"`. A bare number is read in `defaultSystem`
 * (cm for metric, inches for imperial).
 */
export function parseHeightCm(text: string, defaultSystem: UnitSystem = 'metric'): number | null {
  const s = text.trim().toLowerCase().replace(/[\u2019\u2032]/g, "'").replace(/[\u201d\u2033]/g, '"');
  if (s === '') return null;

  const ftIn =
    /^(\d+(?:\.\d+)?)\s*(?:'|ft|feet|foot)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in|inch|inches)?)?$/.exec(s);
  if (ftIn) {
    const feet = Number(ftIn[1]);
    const inches = ftIn[2] === undefined ? 0 : Number(ftIn[2]);
    return ftInToCm(feet, inches);
  }

  const m = /^([\d.,]+)\s*(cm|m|in|inch|inches|")?$/.exec(s);
  if (!m) return null;
  const value = parseNumber(m[1] ?? '');
  if (value === null) return null;
  switch (m[2]) {
    case 'cm':
      return value;
    case 'm':
      return value * 100;
    case 'in':
    case 'inch':
    case 'inches':
    case '"':
      return inToCm(value);
    default:
      return defaultSystem === 'metric' ? value : inToCm(value);
  }
}

// --------------------------------------------------------- portions

/**
 * A named serving size for a food: "1 slice" = 30 g, "1 cup" = 240 g, ...
 * `grams` is the mass of ONE unit of the portion.
 */
export interface PortionUnit {
  label: string;
  grams: number;
}

/** Plain gram "portion" (1 unit = 1 g). */
export const GRAM_PORTION: PortionUnit = { label: 'g', grams: 1 };

/**
 * Grams for `amount` units of a portion: `amount * portion.grams`.
 * E.g. 1.5 x { label: 'slice', grams: 30 } = 45 g.
 */
export function gramsFor(amount: number, portion: PortionUnit): number {
  return amount * portion.grams;
}

/**
 * Inverse of {@link gramsFor}: how many units of `portion` are `grams`
 * (`grams / portion.grams`).
 */
export function amountFor(grams: number, portion: PortionUnit): number {
  if (portion.grams <= 0) throw new RangeError('portion.grams must be positive');
  return grams / portion.grams;
}

/**
 * Builds volume-based portions (1 cup, 1 tbsp, 1 tsp, 1 fl oz) for a food of
 * known density (g/ml), e.g. milk 1.03 -> cup = 247.2 g.
 */
export function volumePortions(densityGPerMl: number): PortionUnit[] {
  const units: { label: string; unit: VolumeUnit }[] = [
    { label: 'cup', unit: 'cup' },
    { label: 'tbsp', unit: 'tbsp' },
    { label: 'tsp', unit: 'tsp' },
    { label: 'fl oz', unit: 'fl_oz' },
  ];
  return units.map(({ label, unit }) => ({
    label,
    grams: gramsFromVolume(convertVolume(1, unit, 'ml'), densityGPerMl),
  }));
}
