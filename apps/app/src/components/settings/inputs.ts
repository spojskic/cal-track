import {
  cmToFtIn,
  ftInToCm,
  kgToLb,
  parseNumber,
  parseWeightKg,
  resolveTargets,
  type ResolveTargetsInput,
  type ResolvedTargetsCore,
  type UnitSystem,
} from '@ration/core';

/** Plausible human ranges used for input validation. */
export const WEIGHT_LIMITS_KG = { min: 30, max: 400 } as const;
export const HEIGHT_LIMITS_CM = { min: 90, max: 250 } as const;
export const BODY_FAT_LIMITS = { min: 2, max: 60 } as const;

export const weightUnitLabel = (system: UnitSystem) => (system === 'metric' ? 'kg' : 'lb');

/** Number to editable text with at most `decimals` decimals ("80", "80.5"). */
export function numberToInput(n: number, decimals = 1): string {
  return String(Number(n.toFixed(decimals)));
}

/** Weight stored in kg as the text shown in the user's unit. */
export function kgToInput(kg: number, system: UnitSystem): string {
  return numberToInput(system === 'metric' ? kg : kgToLb(kg), 1);
}

export interface Parsed<T> {
  value: T | null;
  error: string | null;
}

/** Parses a typed body weight into kg. Accepts "80", "176 lb", "80kg" ... (core parser). */
export function parseWeightInput(text: string, system: UnitSystem): Parsed<number> {
  if (text.trim() === '') return { value: null, error: 'Enter your weight.' };
  const kg = parseWeightKg(text, system);
  if (kg === null) {
    return { value: null, error: `Enter a valid weight, e.g. ${system === 'metric' ? '80.5' : '177'}.` };
  }
  if (kg < WEIGHT_LIMITS_KG.min || kg > WEIGHT_LIMITS_KG.max) {
    const lo = system === 'metric' ? WEIGHT_LIMITS_KG.min : Math.round(kgToLb(WEIGHT_LIMITS_KG.min));
    const hi = system === 'metric' ? WEIGHT_LIMITS_KG.max : Math.round(kgToLb(WEIGHT_LIMITS_KG.max));
    return { value: null, error: `Weight must be between ${lo} and ${hi} ${weightUnitLabel(system)}.` };
  }
  return { value: kg, error: null };
}

/** Optional body fat percentage: blank is fine (null, no error). */
export function parseBodyFatInput(text: string): Parsed<number> {
  if (text.trim() === '') return { value: null, error: null };
  const n = parseNumber(text);
  if (n === null) return { value: null, error: 'Enter a percentage, e.g. 22.5.' };
  if (n < BODY_FAT_LIMITS.min || n > BODY_FAT_LIMITS.max) {
    return {
      value: null,
      error: `Body fat must be between ${BODY_FAT_LIMITS.min}% and ${BODY_FAT_LIMITS.max}%.`,
    };
  }
  return { value: n, error: null };
}

/** Height as typed: centimetres, or feet + inches. */
export interface HeightInput {
  cm: string;
  ft: string;
  inch: string;
}

export const EMPTY_HEIGHT: HeightInput = { cm: '', ft: '', inch: '' };

export function heightToInput(cm: number | null, system: UnitSystem): HeightInput {
  if (cm === null || !Number.isFinite(cm)) return EMPTY_HEIGHT;
  if (system === 'metric') return { cm: numberToInput(cm, 1), ft: '', inch: '' };
  const { feet, inches } = cmToFtIn(cm);
  return { cm: '', ft: String(feet), inch: String(inches) };
}

export function parseHeightInput(input: HeightInput, system: UnitSystem): Parsed<number> {
  let cm: number | null;
  if (system === 'metric') {
    if (input.cm.trim() === '') return { value: null, error: 'Enter your height.' };
    cm = parseNumber(input.cm);
    if (cm === null) return { value: null, error: 'Enter a valid height in cm, e.g. 178.' };
  } else {
    if (input.ft.trim() === '') return { value: null, error: 'Enter your height.' };
    const feet = parseNumber(input.ft);
    const inches = input.inch.trim() === '' ? 0 : parseNumber(input.inch);
    if (feet === null || inches === null) {
      return { value: null, error: 'Enter a valid height, e.g. 5 ft 10 in.' };
    }
    cm = ftInToCm(feet, inches);
  }
  if (cm < HEIGHT_LIMITS_CM.min || cm > HEIGHT_LIMITS_CM.max) {
    return {
      value: null,
      error:
        system === 'metric'
          ? `Height must be between ${HEIGHT_LIMITS_CM.min} and ${HEIGHT_LIMITS_CM.max} cm.`
          : 'Height must be between 3 ft and 8 ft.',
    };
  }
  return { value: cm, error: null };
}

/** Re-expresses a typed weight in another unit system (leaves unparsable text untouched). */
export function convertWeightInput(text: string, from: UnitSystem, to: UnitSystem): string {
  if (from === to) return text;
  const kg = parseWeightKg(text, from);
  return kg === null ? text : kgToInput(kg, to);
}

/** Re-expresses a typed height in another unit system (leaves unparsable text untouched). */
export function convertHeightInput(input: HeightInput, from: UnitSystem, to: UnitSystem): HeightInput {
  if (from === to) return input;
  const parsed = parseHeightInput(input, from);
  return parsed.value === null ? input : heightToInput(parsed.value, to);
}

/** `resolveTargets` that returns null instead of throwing on unusable input (for live previews). */
export function safeResolve(input: ResolveTargetsInput | null): ResolvedTargetsCore | null {
  if (!input) return null;
  try {
    return resolveTargets(input);
  } catch {
    return null;
  }
}
