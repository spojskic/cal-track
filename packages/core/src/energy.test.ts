import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_FRACTIONS,
  ageFromBirthdate,
  baselineActivityKcal,
  bmrCunningham,
  bmrHarrisBenedictRevised,
  bmrKatchMcArdle,
  bmrMifflin,
  computeBmr,
  computeEnergyTarget,
  computeExpenditure,
  dailyDeltaFromRate,
  dedupeExercises,
  energyFloor,
  isDeviceDayComplete,
  exerciseKcalGrossMet,
  exerciseKcalNetMet,
  leanMass,
  maxSafeLossRateKgPerWeek,
  resolveBmrFormula,
  tefKcal,
  type BmrProfile,
  type ExpenditureInput,
} from './energy';

describe('BMR formulas', () => {
  it('Mifflin-St Jeor: male 80 kg / 180 cm / 30 y = 1780', () => {
    // 10*80 + 6.25*180 - 5*30 + 5 = 800 + 1125 - 150 + 5
    expect(bmrMifflin(80, 180, 30, 'male')).toBe(1780);
  });

  it('Mifflin-St Jeor: female 60 kg / 165 cm / 25 y = 1345.25', () => {
    // 600 + 1031.25 - 125 - 161
    expect(bmrMifflin(60, 165, 25, 'female')).toBeCloseTo(1345.25, 10);
  });

  it('Katch-McArdle: 70 kg lean mass = 1882', () => {
    expect(bmrKatchMcArdle(70)).toBeCloseTo(1882, 10); // 370 + 21.6 * 70
  });

  it('Cunningham: 70 kg lean mass = 2040', () => {
    expect(bmrCunningham(70)).toBe(2040); // 500 + 22 * 70
  });

  it('Harris-Benedict (revised): male 80/180/30 and female 60/165/25', () => {
    // 88.362 + 1071.76 + 863.82 - 170.31
    expect(bmrHarrisBenedictRevised(80, 180, 30, 'male')).toBeCloseTo(1853.632, 6);
    // 447.593 + 554.82 + 511.17 - 108.25
    expect(bmrHarrisBenedictRevised(60, 165, 25, 'female')).toBeCloseTo(1405.333, 6);
  });

  it('computes lean mass', () => {
    expect(leanMass(80, 20)).toBeCloseTo(64, 10);
    expect(leanMass(100, 25)).toBeCloseTo(75, 10);
    expect(() => leanMass(80, 100)).toThrow(RangeError);
    expect(() => leanMass(80, -1)).toThrow(RangeError);
    expect(() => leanMass(0, 20)).toThrow(RangeError);
  });

  it('rejects invalid inputs', () => {
    expect(() => bmrMifflin(-1, 180, 30, 'male')).toThrow(RangeError);
    expect(() => bmrMifflin(80, 0, 30, 'male')).toThrow(RangeError);
    expect(() => bmrMifflin(80, 180, Number.NaN, 'male')).toThrow(RangeError);
  });
});

describe('computeBmr', () => {
  const profile: BmrProfile = {
    sex: 'male',
    age: 30,
    weightKg: 80,
    heightCm: 180,
    bodyFatPct: 20,
    manualBmr: 1700,
  };

  it('dispatches on the formula', () => {
    expect(computeBmr(profile, 'mifflin')).toBe(1780);
    expect(computeBmr(profile, 'harris_benedict')).toBeCloseTo(1853.632, 6);
    // lean mass = 64 kg: 370 + 21.6*64 = 1752.4 ; 500 + 22*64 = 1908
    expect(computeBmr(profile, 'katch_mcardle')).toBeCloseTo(1752.4, 10);
    expect(computeBmr(profile, 'cunningham')).toBeCloseTo(1908, 10);
    expect(computeBmr(profile, 'manual')).toBe(1700);
  });

  it('falls back to Mifflin without body fat or manual override', () => {
    const noFat: BmrProfile = { ...profile, bodyFatPct: null, manualBmr: null };
    expect(computeBmr(noFat, 'katch_mcardle')).toBe(1780);
    expect(computeBmr(noFat, 'cunningham')).toBe(1780);
    expect(computeBmr(noFat, 'manual')).toBe(1780);
    expect(resolveBmrFormula(noFat, 'katch_mcardle')).toBe('mifflin');
    expect(resolveBmrFormula(noFat, 'manual')).toBe('mifflin');
    expect(resolveBmrFormula(profile, 'katch_mcardle')).toBe('katch_mcardle');
    expect(resolveBmrFormula(noFat, 'harris_benedict')).toBe('harris_benedict');
  });
});

describe('baseline activity', () => {
  it('is the classic multiplier minus one, as a fraction of BMR', () => {
    expect(ACTIVITY_FRACTIONS).toEqual({ sedentary: 0.2, light: 0.375, moderate: 0.55, very: 0.725 });
    expect(baselineActivityKcal(1780, 'sedentary')).toBeCloseTo(356, 10);
    expect(baselineActivityKcal(1780, 'light')).toBeCloseTo(667.5, 10);
    expect(baselineActivityKcal(1780, 'moderate')).toBeCloseTo(979, 10);
    expect(baselineActivityKcal(1780, 'very')).toBeCloseTo(1290.5, 10);
    // bmr + baseline == bmr * classic multiplier
    expect(1780 + baselineActivityKcal(1780, 'moderate')).toBeCloseTo(1780 * 1.55, 10);
  });
});

describe('exercise and TEF', () => {
  it('computes net MET energy: (MET - 1) * kg * minutes / 60', () => {
    expect(exerciseKcalNetMet(8, 80, 30)).toBeCloseTo(280, 10); // 7 * 80 * 0.5
    expect(exerciseKcalNetMet(3.5, 70, 60)).toBeCloseTo(175, 10); // 2.5 * 70
    expect(exerciseKcalNetMet(0.95, 70, 60)).toBe(0); // below resting
    expect(exerciseKcalNetMet(8, 80, 0)).toBe(0);
  });

  it('computes gross MET energy: MET * kg * minutes / 60', () => {
    expect(exerciseKcalGrossMet(8, 80, 30)).toBeCloseTo(320, 10);
    expect(exerciseKcalGrossMet(8, 80, 30) - exerciseKcalNetMet(8, 80, 30)).toBeCloseTo(40, 10); // 1 MET resting
  });

  it('computes TEF', () => {
    expect(tefKcal(2000, true)).toBeCloseTo(200, 10);
    expect(tefKcal(2000, true, 0.08)).toBeCloseTo(160, 10);
    expect(tefKcal(2000, false)).toBe(0);
    expect(tefKcal(-50, true)).toBe(0);
  });
});

describe('computeExpenditure - worked examples', () => {
  // Shared day: BMR 1780, sedentary baseline 356, 300 kcal manual exercise, ate 2000 kcal (TEF 200).
  const base: ExpenditureInput = {
    mode: 'static',
    bmr: 1780,
    baselineActivityKcal: 356,
    manualExerciseKcal: 300,
    intakeKcal: 2000,
    tefEnabled: true,
  };

  it('static = bmr + baseline + manual exercise + TEF', () => {
    const r = computeExpenditure(base);
    expect(r).toEqual({
      mode: 'static',
      bmr: 1780,
      baselineActivity: 356,
      exercise: 300,
      deviceAboveBaseline: 0,
      tef: 200,
      total: 2636, // 1780 + 356 + 300 + 200
    });
  });

  it('static ignores device numbers and respects TEF off', () => {
    const r = computeExpenditure({ ...base, tefEnabled: false, deviceActiveKcal: 900, deviceRestingKcal: 2000 });
    expect(r.total).toBe(2436);
    expect(r.tef).toBe(0);
  });

  it('device_adjusted adds only the device active energy above baseline', () => {
    // device active 700 -> above baseline = 344 ; total = 1780 + 356 + 344 + 300 + 200
    const r = computeExpenditure({ ...base, mode: 'device_adjusted', deviceActiveKcal: 700 });
    expect(r.deviceAboveBaseline).toBe(344);
    expect(r.exercise).toBe(300);
    expect(r.total).toBe(2980);
  });

  it('device_adjusted never goes below the static result', () => {
    const low = computeExpenditure({ ...base, mode: 'device_adjusted', deviceActiveKcal: 200 });
    expect(low.deviceAboveBaseline).toBe(0);
    expect(low.total).toBe(2636);
    const none = computeExpenditure({ ...base, mode: 'device_adjusted' });
    expect(none.total).toBe(2636);
  });

  it('device_total uses device active + resting energy and ignores our BMR/baseline/exercise', () => {
    // 700 + 1850 + 200 TEF
    const r = computeExpenditure({
      ...base,
      mode: 'device_total',
      deviceActiveKcal: 700,
      deviceRestingKcal: 1850,
    });
    expect(r).toEqual({
      mode: 'device_total',
      bmr: 1850,
      baselineActivity: 0,
      exercise: 0,
      deviceAboveBaseline: 700,
      tef: 200,
      total: 2750,
    });
  });

  it('device_total falls back to our BMR when the device has no resting energy', () => {
    const r = computeExpenditure({ ...base, mode: 'device_total', deviceActiveKcal: 700 });
    expect(r.total).toBe(2680); // 700 + 1780 + 200
  });

  it('device_total falls back to baseline + manual exercise without active energy', () => {
    const r = computeExpenditure({ ...base, mode: 'device_total', deviceRestingKcal: 1850 });
    expect(r.total).toBe(2706); // 1850 + 356 + 300 + 200
  });

  describe('a device day that is not finished (cumulative counters, e.g. Garmin resting 801 kcal at midday)', () => {
    const midday = { ...base, mode: 'device_total' as const, deviceActiveKcal: 150, deviceRestingKcal: 801 };

    it('device_total does not treat the resting-so-far as a whole day of BMR: our BMR stands in', () => {
      const r = computeExpenditure({ ...midday, deviceDayComplete: false });
      expect(r).toEqual({
        mode: 'device_total',
        bmr: 1780, // not 801
        baselineActivity: 0,
        exercise: 0,
        deviceAboveBaseline: 150,
        tef: 200,
        total: 2130, // 1780 + 150 + 200
      });
      // the same row on a finished day is used as measured
      expect(computeExpenditure({ ...midday, deviceDayComplete: true }).total).toBe(1151); // 801 + 150 + 200
      expect(computeExpenditure(midday).total).toBe(1151); // default = complete (unchanged behaviour)
    });

    it('never goes below what the device has already measured', () => {
      const late = computeExpenditure({ ...midday, deviceRestingKcal: 1900, deviceDayComplete: false });
      expect(late.bmr).toBe(1900);
      expect(late.total).toBe(1900 + 150 + 200);
    });

    it('does not double count with our own BMR / baseline / manual exercise', () => {
      const r = computeExpenditure({ ...midday, deviceDayComplete: false });
      expect(r.baselineActivity).toBe(0);
      expect(r.exercise).toBe(0); // manual 300 and baseline 356 are not added on top of the device's active energy
      expect(r.total).toBeCloseTo(r.bmr + r.deviceAboveBaseline + r.tef, 10);
    });

    it('static and device_adjusted ignore the flag (they never read resting energy)', () => {
      for (const mode of ['static', 'device_adjusted'] as const) {
        const a = computeExpenditure({ ...midday, mode, deviceDayComplete: false });
        const b = computeExpenditure({ ...midday, mode, deviceDayComplete: true });
        expect(a).toEqual(b);
      }
    });

    it('device_adjusted counts only ACTIVE energy above the baseline, so a partial day can only under-count', () => {
      const early = computeExpenditure({ ...base, mode: 'device_adjusted', deviceActiveKcal: 150, deviceRestingKcal: 801, deviceDayComplete: false });
      expect(early.deviceAboveBaseline).toBe(0); // 150 < baseline 356
      expect(early.bmr).toBe(1780);
      expect(early.total).toBe(2636);
    });
  });

  it('always satisfies total = sum of components', () => {
    for (const mode of ['static', 'device_adjusted', 'device_total'] as const) {
      for (const deviceDayComplete of [true, false]) {
        const r = computeExpenditure({
          ...base,
          mode,
          deviceActiveKcal: 650,
          deviceRestingKcal: 1900,
          deviceDayComplete,
        });
        expect(r.total).toBeCloseTo(
          r.bmr + r.baselineActivity + r.exercise + r.deviceAboveBaseline + r.tef,
          10,
        );
      }
    }
  });

  it('uses a custom TEF percentage', () => {
    expect(computeExpenditure({ ...base, tefPct: 0.05 }).tef).toBeCloseTo(100, 10);
  });
});

describe('isDeviceDayComplete', () => {
  const dayEnd = Date.UTC(2026, 10, 10); // end of 2026-11-09
  it('today and future days are never complete', () => {
    expect(isDeviceDayComplete({ date: '2026-11-10', today: '2026-11-10' })).toBe(false);
    expect(isDeviceDayComplete({ date: '2026-11-11', today: '2026-11-10' })).toBe(false);
  });
  it('a past day is complete when no timestamps are known', () => {
    expect(isDeviceDayComplete({ date: '2026-11-09', today: '2026-11-10' })).toBe(true);
    expect(isDeviceDayComplete({ date: '2026-11-09', today: '2026-11-10', updatedAtMs: null, dayEndMs: dayEnd })).toBe(true);
    expect(isDeviceDayComplete({ date: '2026-11-09', today: '2026-11-10', updatedAtMs: dayEnd, dayEndMs: undefined })).toBe(true);
  });
  it('a past day last written before it ended is still partial (the watch has not synced since)', () => {
    expect(isDeviceDayComplete({ date: '2026-11-09', today: '2026-11-10', updatedAtMs: dayEnd - 1, dayEndMs: dayEnd })).toBe(false);
    expect(isDeviceDayComplete({ date: '2026-11-09', today: '2026-11-10', updatedAtMs: dayEnd, dayEndMs: dayEnd })).toBe(true);
    expect(isDeviceDayComplete({ date: '2026-11-09', today: '2026-11-10', updatedAtMs: dayEnd + 3_600_000, dayEndMs: dayEnd })).toBe(true);
    expect(isDeviceDayComplete({ date: '2026-11-09', today: '2026-11-10', updatedAtMs: Number.NaN, dayEndMs: dayEnd })).toBe(true);
  });
});

describe('dedupeExercises', () => {
  const device = [{ startMs: 1000, endMs: 2000 }];
  const keep = (entries: { id: string; startMs?: number; endMs?: number; kcal: number }[]) =>
    dedupeExercises(entries, device).map((e) => e.id);

  it('drops manual entries that overlap a device workout', () => {
    expect(
      keep([
        { id: 'inside', startMs: 1200, endMs: 1800, kcal: 100 },
        { id: 'partial-start', startMs: 900, endMs: 1100, kcal: 100 },
        { id: 'partial-end', startMs: 1900, endMs: 2500, kcal: 100 },
        { id: 'enclosing', startMs: 500, endMs: 3000, kcal: 100 },
      ]),
    ).toEqual([]);
  });

  it('keeps non-overlapping, touching and untimed entries', () => {
    expect(
      keep([
        { id: 'before', startMs: 100, endMs: 900, kcal: 50 },
        { id: 'touch-end', startMs: 500, endMs: 1000, kcal: 50 },
        { id: 'touch-start', startMs: 2000, endMs: 2500, kcal: 50 },
        { id: 'after', startMs: 3000, endMs: 4000, kcal: 50 },
        { id: 'no-times', kcal: 50 },
      ]),
    ).toEqual(['before', 'touch-end', 'touch-start', 'after', 'no-times']);
  });

  it('treats an entry with a single timestamp as an instant', () => {
    expect(keep([{ id: 'in', startMs: 1500, kcal: 1 }])).toEqual([]);
    expect(keep([{ id: 'out', startMs: 2500, kcal: 1 }])).toEqual(['out']);
    expect(keep([{ id: 'end-in', endMs: 1500, kcal: 1 }])).toEqual([]);
  });

  it('handles multiple device workouts, no workouts, and preserves entry objects', () => {
    const entries = [{ startMs: 5000, endMs: 5500, kcal: 120 }];
    expect(dedupeExercises(entries, [])).toEqual(entries);
    expect(dedupeExercises(entries, [{ startMs: 0, endMs: 100 }, { startMs: 5400, endMs: 6000 }])).toEqual([]);
  });
});

describe('weight goal', () => {
  it('converts rate to daily delta with the 7700 kcal/kg rule', () => {
    expect(dailyDeltaFromRate(-0.5)).toBeCloseTo(-550, 10);
    expect(dailyDeltaFromRate(0.25)).toBeCloseTo(275, 10);
    expect(dailyDeltaFromRate(0)).toBe(0);
    expect(dailyDeltaFromRate(-1) * 7).toBeCloseTo(-7700, 10);
  });

  it('limits loss to 1% of body weight per week', () => {
    expect(maxSafeLossRateKgPerWeek(80)).toBeCloseTo(0.8, 10);
    expect(maxSafeLossRateKgPerWeek(55)).toBeCloseTo(0.55, 10);
  });

  it('has sex-specific floors', () => {
    expect(energyFloor('male')).toBe(1500);
    expect(energyFloor('female')).toBe(1200);
  });

  it('computes a target above the floor (male, -0.25 kg/week)', () => {
    // maintenance 1780 + 356 = 2136 ; delta -275 ; target 1861
    const r = computeEnergyTarget({ bmr: 1780, baselineActivityKcal: 356, rateKgPerWeek: -0.25, sex: 'male' });
    expect(r).toEqual({
      target: 1861,
      maintenance: 2136,
      delta: -275,
      floor: 1500,
      flooredBy: 0,
      belowBmr: false,
    });
  });

  it('flags a target below BMR even when the floor does not apply', () => {
    // 2136 - 550 = 1586 (> floor 1500, < BMR 1780)
    const r = computeEnergyTarget({ bmr: 1780, baselineActivityKcal: 356, rateKgPerWeek: -0.5, sex: 'male' });
    expect(r.target).toBe(1586);
    expect(r.flooredBy).toBe(0);
    expect(r.belowBmr).toBe(true);
  });

  it('applies the 1200 kcal floor for women', () => {
    // bmr 1345.25 ; baseline 269.05 ; maintenance 1614.3 ; delta -825 ; raw 789.3 -> floor 1200
    const bmr = bmrMifflin(60, 165, 25, 'female');
    const r = computeEnergyTarget({
      bmr,
      baselineActivityKcal: baselineActivityKcal(bmr, 'sedentary'),
      rateKgPerWeek: -0.75,
      sex: 'female',
    });
    expect(r.maintenance).toBeCloseTo(1614.3, 8);
    expect(r.delta).toBeCloseTo(-825, 10);
    expect(r.target).toBe(1200);
    expect(r.floor).toBe(1200);
    expect(r.flooredBy).toBeCloseTo(410.7, 8);
    expect(r.belowBmr).toBe(true);
  });

  it('applies the 1500 kcal floor for men and a custom floor override', () => {
    const r = computeEnergyTarget({ bmr: 1500, baselineActivityKcal: 300, rateKgPerWeek: -1, sex: 'male' });
    expect(r.target).toBe(1500); // 1800 - 1100 = 700 -> floor
    expect(r.flooredBy).toBe(800);
    const custom = computeEnergyTarget({
      bmr: 1500,
      baselineActivityKcal: 300,
      rateKgPerWeek: -1,
      sex: 'male',
      floorKcal: 1000,
    });
    expect(custom.target).toBe(1000);
    expect(custom.flooredBy).toBe(300);
  });

  it('adds surplus for a gain goal', () => {
    const r = computeEnergyTarget({ bmr: 1780, baselineActivityKcal: 356, rateKgPerWeek: 0.25, sex: 'male' });
    expect(r.target).toBe(2411);
    expect(r.belowBmr).toBe(false);
  });
});

describe('ageFromBirthdate', () => {
  it('counts completed years', () => {
    expect(ageFromBirthdate('1990-06-15', '2024-06-14')).toBe(33);
    expect(ageFromBirthdate('1990-06-15', '2024-06-15')).toBe(34);
    expect(ageFromBirthdate('1990-06-15', '2024-12-31')).toBe(34);
    expect(ageFromBirthdate('2024-06-15', '2024-06-15')).toBe(0);
  });

  it('handles leap-day birthdays', () => {
    expect(ageFromBirthdate('2000-02-29', '2023-02-28')).toBe(22);
    expect(ageFromBirthdate('2000-02-29', '2023-03-01')).toBe(23);
    expect(ageFromBirthdate('2000-02-29', '2024-02-29')).toBe(24);
  });

  it('ignores a time part and never returns negative ages', () => {
    expect(ageFromBirthdate('1990-06-15T10:00:00Z', '2024-06-15T00:00:00Z')).toBe(34);
    expect(ageFromBirthdate('2030-01-01', '2024-01-01')).toBe(0);
  });

  it('rejects malformed dates', () => {
    expect(() => ageFromBirthdate('15/06/1990', '2024-01-01')).toThrow(RangeError);
    expect(() => ageFromBirthdate('1990-13-01', '2024-01-01')).toThrow(RangeError);
  });
});
