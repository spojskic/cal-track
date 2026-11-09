import { describe, expect, it } from 'vitest';
import {
  amountFor,
  cmToFtIn,
  cmToIn,
  convertLength,
  convertMass,
  convertVolume,
  formatFoodMass,
  formatHeight,
  formatWeight,
  flOzToMl,
  ftInToCm,
  gToOz,
  gramsFor,
  gramsFromVolume,
  inToCm,
  kgToLb,
  kgToStone,
  lbToKg,
  mlToFlOz,
  ozToG,
  parseHeightCm,
  parseNumber,
  parseWeightKg,
  stoneToKg,
  volumeFromGrams,
  volumePortions,
} from './units';

describe('mass', () => {
  it('converts kg <-> lb', () => {
    expect(kgToLb(1)).toBeCloseTo(2.2046226, 6);
    expect(kgToLb(80)).toBeCloseTo(176.3698, 3);
    expect(lbToKg(150)).toBeCloseTo(68.0388555, 6);
    expect(lbToKg(kgToLb(63.2))).toBeCloseTo(63.2, 10);
  });

  it('converts g <-> oz', () => {
    expect(ozToG(1)).toBeCloseTo(28.349523125, 9);
    expect(gToOz(100)).toBeCloseTo(3.5273962, 6);
  });

  it('converts stone', () => {
    expect(stoneToKg(1)).toBeCloseTo(6.35029318, 7);
    expect(kgToStone(63.5029318)).toBeCloseTo(10, 6);
    expect(convertMass(1, 'kg', 'g')).toBe(1000);
    expect(convertMass(16, 'oz', 'lb')).toBeCloseTo(1, 9);
  });
});

describe('volume', () => {
  it('uses label conventions for cup, tbsp and tsp', () => {
    expect(convertVolume(1, 'cup', 'ml')).toBe(240);
    expect(convertVolume(1, 'tbsp', 'ml')).toBe(15);
    expect(convertVolume(1, 'tsp', 'ml')).toBe(5);
    expect(convertVolume(2, 'tbsp', 'tsp')).toBe(6);
    expect(convertVolume(1, 'l', 'cup')).toBeCloseTo(1000 / 240, 10);
  });

  it('converts US fluid ounces', () => {
    expect(flOzToMl(1)).toBeCloseTo(29.5735295625, 9);
    expect(mlToFlOz(355)).toBeCloseTo(12.004, 3);
  });

  it('converts between mass and volume with a density', () => {
    expect(gramsFromVolume(250, 1.03)).toBeCloseTo(257.5, 10);
    expect(volumeFromGrams(257.5, 1.03)).toBeCloseTo(250, 10);
    expect(() => volumeFromGrams(10, 0)).toThrow(RangeError);
  });
});

describe('length', () => {
  it('converts cm <-> in', () => {
    expect(cmToIn(2.54)).toBeCloseTo(1, 12);
    expect(inToCm(71)).toBeCloseTo(180.34, 10);
    expect(convertLength(1, 'ft', 'cm')).toBeCloseTo(30.48, 10);
    expect(convertLength(1.8, 'm', 'cm')).toBeCloseTo(180, 10);
  });

  it('converts feet+inches both ways', () => {
    expect(ftInToCm(5, 11)).toBeCloseTo(180.34, 10);
    expect(cmToFtIn(180)).toEqual({ feet: 5, inches: 11 }); // 70.87 in -> 71 in
    expect(cmToFtIn(182.88)).toEqual({ feet: 6, inches: 0 });
    expect(cmToFtIn(151.1)).toEqual({ feet: 4, inches: 11 }); // 59.49 in -> 59
  });

  it('carries 12 inches into a foot', () => {
    expect(cmToFtIn(182)).toEqual({ feet: 6, inches: 0 }); // 71.65 in -> 72
  });
});

describe('formatting', () => {
  it('formats weight', () => {
    expect(formatWeight(80, 'metric')).toBe('80 kg');
    expect(formatWeight(80.46, 'metric')).toBe('80.5 kg');
    expect(formatWeight(80, 'imperial')).toBe('176.4 lb');
  });

  it('formats height', () => {
    expect(formatHeight(180, 'metric')).toBe('180 cm');
    expect(formatHeight(180, 'imperial')).toBe('5\'11"');
    expect(formatHeight(152.4, 'imperial')).toBe('5\'0"');
  });

  it('formats food mass', () => {
    expect(formatFoodMass(150, 'metric')).toBe('150 g');
    expect(formatFoodMass(100, 'imperial')).toBe('3.5 oz');
  });
});

describe('parseNumber', () => {
  it('parses decimals, commas, fractions and mixed numbers', () => {
    expect(parseNumber('2.5')).toBe(2.5);
    expect(parseNumber('1,5')).toBe(1.5);
    expect(parseNumber('1/2')).toBe(0.5);
    expect(parseNumber('1 1/2')).toBe(1.5);
    expect(parseNumber(' 3 ')).toBe(3);
  });

  it('rejects garbage', () => {
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('1/0')).toBeNull();
    expect(parseNumber('-1')).toBeNull();
  });
});

describe('parseWeightKg', () => {
  it('parses metric and imperial text', () => {
    expect(parseWeightKg('80')).toBe(80);
    expect(parseWeightKg('80 kg')).toBe(80);
    expect(parseWeightKg('500 g')).toBeCloseTo(0.5, 10);
    expect(parseWeightKg('150 lbs')).toBeCloseTo(68.0388555, 6);
    expect(parseWeightKg('176.37lb')).toBeCloseTo(80, 2);
    expect(parseWeightKg('176.37', 'imperial')).toBeCloseTo(80, 2);
    expect(parseWeightKg('80,5 kg')).toBeCloseTo(80.5, 10);
  });

  it('parses stone and pounds', () => {
    // 12 st = 76.2035182 kg, 4 lb = 1.8143695 kg
    expect(parseWeightKg('12 st 4 lb')).toBeCloseTo(78.0178877, 6);
    expect(parseWeightKg('12st')).toBeCloseTo(76.2035182, 6);
  });

  it('returns null for unparseable input', () => {
    expect(parseWeightKg('abc')).toBeNull();
    expect(parseWeightKg('80 xyz')).toBeNull();
    expect(parseWeightKg('')).toBeNull();
  });
});

describe('parseHeightCm', () => {
  it('parses metric forms', () => {
    expect(parseHeightCm('180')).toBe(180);
    expect(parseHeightCm('180cm')).toBe(180);
    expect(parseHeightCm('1.8 m')).toBeCloseTo(180, 10);
  });

  it('parses imperial forms', () => {
    expect(parseHeightCm('5\'11"')).toBeCloseTo(180.34, 10);
    expect(parseHeightCm("5' 11")).toBeCloseTo(180.34, 10);
    expect(parseHeightCm('5 ft 11 in')).toBeCloseTo(180.34, 10);
    expect(parseHeightCm('5 feet 11 inches')).toBeCloseTo(180.34, 10);
    expect(parseHeightCm('71 in')).toBeCloseTo(180.34, 10);
    expect(parseHeightCm('6ft')).toBeCloseTo(182.88, 10);
    expect(parseHeightCm('71', 'imperial')).toBeCloseTo(180.34, 10);
  });

  it('returns null for unparseable input', () => {
    expect(parseHeightCm('tall')).toBeNull();
    expect(parseHeightCm('')).toBeNull();
  });
});

describe('portions', () => {
  it('computes grams for an amount of a portion', () => {
    const slice = { label: 'slice', grams: 30 };
    expect(gramsFor(1.5, slice)).toBe(45);
    expect(amountFor(45, slice)).toBe(1.5);
    expect(() => amountFor(10, { label: 'bad', grams: 0 })).toThrow(RangeError);
  });

  it('builds volume portions from a density', () => {
    const portions = volumePortions(1.0);
    expect(portions.find((p) => p.label === 'cup')?.grams).toBe(240);
    expect(portions.find((p) => p.label === 'tbsp')?.grams).toBe(15);
    expect(portions.find((p) => p.label === 'tsp')?.grams).toBe(5);
    expect(portions.find((p) => p.label === 'fl oz')?.grams).toBeCloseTo(29.5735, 4);
    expect(volumePortions(1.03).find((p) => p.label === 'cup')?.grams).toBeCloseTo(247.2, 10);
  });
});
