import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_FRACTIONS,
  AWAKE_HOURS,
  DEFAULT_ENERGY_SUMMARY_MODE,
  adjustedBaselineKcal,
  ageFromBirthdate,
  baselineActivityKcal,
  bmrCunningham,
  bmrHarrisBenedictRevised,
  bmrKatchMcArdle,
  bmrMifflin,
  budgetExtraKcal,
  computeBmr,
  computeEnergyTarget,
  computeExpenditure,
  dailyDeltaFromRate,
  dedupeExercises,
  energyFloor,
  energyRemaining,
  energySummaryCaption,
  isDeviceDayComplete,
  nextEnergySummaryMode,
  normalizeEnergySummaryMode,
  exerciseKcalGrossMet,
  exerciseKcalNetMet,
  foodForNetKcal,
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
    expect(ACTIVITY_FRACTIONS).toEqual({ none: 0, sedentary: 0.2, light: 0.375, moderate: 0.55, very: 0.725 });
    expect(baselineActivityKcal(1780, 'none')).toBe(0);
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
  // Shared day: BMR 1780, sedentary baseline 356, 300 kcal manual exercise (no duration), ate 2000 kcal (TEF 200).
  const base: ExpenditureInput = {
    mode: 'static',
    bmr: 1780,
    baselineActivityKcal: 356,
    manualExerciseKcal: 300,
    intakeKcal: 2000,
    tefEnabled: true,
  };

  it('static = bmr + baseline + manual exercise + TEF (an exercise without a duration takes no baseline time)', () => {
    const r = computeExpenditure(base);
    expect(r).toEqual({
      mode: 'static',
      bmr: 1780,
      baselineKcal: 356,
      adjustedBaseline: 356,
      trackerActivity: 0,
      exercise: 300,
      tef: 200,
      total: 2636, // 1780 + 356 + 300 + 200 (unchanged: 0 minutes remove nothing from the baseline)
      aboveBaseline: 300, // 356 + 0 + 300 - 356
      baselineActivity: 356,
      deviceAboveBaseline: 0,
    });
  });

  it('static ignores device numbers and respects TEF off', () => {
    const r = computeExpenditure({
      ...base,
      tefEnabled: false,
      deviceActiveKcal: 900,
      deviceWorkoutKcal: 400,
      deviceRestingKcal: 2000,
    });
    expect(r.total).toBe(2436);
    expect(r.tef).toBe(0);
    expect(r.trackerActivity).toBe(0);
  });

  it('static now takes baseline time for the exercise minutes (the same rule as with a device)', () => {
    // CHANGED vs the old formulas: 45 min of exercise remove 45/60 * 356/16 = 16.6875 kcal of baseline, so the total is
    // 1780 + 339.3125 + 300 + 200 = 2619.3125 where it used to be 2636.
    const r = computeExpenditure({ ...base, exerciseMinutes: 45 });
    expect(r.adjustedBaseline).toBeCloseTo(339.3125, 10);
    expect(r.total).toBeCloseTo(2619.3125, 10);
    expect(r.aboveBaseline).toBeCloseTo(283.3125, 10); // 339.3125 + 300 - 356
  });

  describe("Cronometer's own example (BMR 1394, baseline 279, a 60 minute 500 kcal road bike ride)", () => {
    const cronometer: ExpenditureInput = {
      mode: 'static',
      bmr: 1394,
      baselineActivityKcal: 279,
      manualExerciseKcal: 500,
      exerciseMinutes: 60,
      intakeKcal: 0,
      tefEnabled: false,
    };

    it('static: adjusted baseline 261.5625, total 2155.5625, above baseline 482.5625', () => {
      const r = computeExpenditure(cronometer);
      expect(r.adjustedBaseline).toBe(261.5625); // 279 - 279 / 16 (they show 261)
      expect(r.exercise).toBe(500);
      expect(r.total).toBe(2155.5625); // 1394 + 261.5625 + 500 (they show 2155)
      expect(r.aboveBaseline).toBe(482.5625); // (500 + 261.5625) - 279
      expect(Math.floor(r.adjustedBaseline)).toBe(261);
      expect(Math.floor(r.total)).toBe(2155);
    });

    it('the energy target of a maintain-weight goal is 1673 and the budget 1673 + 482.5625 = Burned', () => {
      const energy = computeEnergyTarget({ bmr: 1394, baselineActivityKcal: 279, rateKgPerWeek: 0, sex: 'female' });
      expect(energy.target).toBe(1673);
      const r = computeExpenditure(cronometer);
      expect(energy.target + r.aboveBaseline).toBe(2155.5625);
      expect(energy.target + r.aboveBaseline).toBe(r.total);
    });

    it('device_adjusted with the ride recorded by the watch gives the same numbers (workout only, no extra tracker)', () => {
      const r = computeExpenditure({
        ...cronometer,
        mode: 'device_adjusted',
        manualExerciseKcal: 0,
        deviceActiveKcal: 500,
        deviceWorkoutKcal: 500,
      });
      expect(r.trackerActivity).toBe(0);
      expect(r.exercise).toBe(500);
      expect(r.adjustedBaseline).toBe(261.5625);
      expect(r.total).toBe(2155.5625);
      expect(r.aboveBaseline).toBe(482.5625);
    });
  });

  describe('device_adjusted (Cronometer: the baseline is replaced by tracker activity and exercise time)', () => {
    const day: ExpenditureInput = {
      mode: 'device_adjusted',
      bmr: 1394,
      baselineActivityKcal: 279,
      manualExerciseKcal: 0,
      intakeKcal: 0,
      tefEnabled: false,
    };

    it('no exercise and no device: total = bmr + baseline (the start of the day)', () => {
      const r = computeExpenditure(day);
      expect(r.total).toBe(1394 + 279);
      expect(r.adjustedBaseline).toBe(279);
      expect(r.trackerActivity).toBe(0);
      expect(r.exercise).toBe(0);
      expect(r.aboveBaseline).toBe(0);
      expect(computeExpenditure({ ...day, deviceActiveKcal: 0, deviceWorkoutKcal: 0 }).total).toBe(1673);
    });

    it('tracker activity replaces the baseline one-for-one: 100 kcal of steps -> adjusted baseline 179, same total', () => {
      const r = computeExpenditure({ ...day, deviceActiveKcal: 100 });
      expect(r.trackerActivity).toBe(100);
      expect(r.adjustedBaseline).toBe(179);
      expect(r.total).toBe(1673); // unchanged
      expect(r.aboveBaseline).toBe(0);
    });

    it('tracker activity larger than the baseline: adjusted baseline 0 (hidden), total = bmr + tracker', () => {
      const r = computeExpenditure({ ...day, deviceActiveKcal: 400 });
      expect(r.trackerActivity).toBe(400);
      expect(r.adjustedBaseline).toBe(0);
      expect(r.total).toBe(1394 + 400);
      expect(r.aboveBaseline).toBe(121); // 400 - 279
    });

    it('a device workout is exercise, not tracker activity (the daily active total includes it)', () => {
      // active 800 = 300 of general movement + a 500 kcal / 60 min workout.
      const r = computeExpenditure({ ...day, deviceActiveKcal: 800, deviceWorkoutKcal: 500, exerciseMinutes: 60 });
      expect(r.trackerActivity).toBe(300);
      expect(r.exercise).toBe(500);
      expect(r.adjustedBaseline).toBe(0); // 279 - 300 - 17.4375 -> clamped
      expect(r.total).toBe(1394 + 300 + 500);
      expect(r.aboveBaseline).toBe(521); // 300 + 500 - 279
    });

    it('tracker activity and exercise time both reduce the baseline', () => {
      // active 380 = 80 tracker + a 300 kcal / 90 min workout: 279 - 80 - 279/16*1.5 = 172.84375
      const r = computeExpenditure({ ...day, deviceActiveKcal: 380, deviceWorkoutKcal: 300, exerciseMinutes: 90 });
      expect(r.trackerActivity).toBe(80);
      expect(r.adjustedBaseline).toBeCloseTo(172.84375, 10);
      expect(r.total).toBeCloseTo(1394 + 172.84375 + 80 + 300, 10);
    });

    it('manual exercise on top of a device day (the caller removed entries that overlap a device workout)', () => {
      // The 07:00-07:30 run is not in the watch's workouts, the 09:00 strength session is; the manual 09:10 entry that
      // overlaps it is dropped by dedupeExercises before it reaches computeExpenditure.
      const manual = [
        { kcal: 320, minutes: 30, startMs: 7 * 3_600_000, endMs: 7.5 * 3_600_000 },
        { kcal: 210, minutes: 20, startMs: 9.2 * 3_600_000, endMs: 9.5 * 3_600_000 },
      ];
      const watch = [{ startMs: 9 * 3_600_000, endMs: 9.75 * 3_600_000 }]; // 45 min strength session, 250 kcal
      const kept = dedupeExercises(manual, watch);
      expect(kept).toHaveLength(1);
      const manualKcal = kept.reduce((sum, m) => sum + m.kcal, 0);
      const minutes = 45 + kept.reduce((sum, m) => sum + m.minutes, 0);
      const r = computeExpenditure({
        ...day,
        manualExerciseKcal: manualKcal,
        deviceActiveKcal: 250 + 120,
        deviceWorkoutKcal: 250,
        exerciseMinutes: minutes,
      });
      expect(r.exercise).toBe(250 + 320); // the strength session is counted once
      expect(r.trackerActivity).toBe(120);
      expect(r.adjustedBaseline).toBeCloseTo(279 - 120 - (279 / 16) * 1.25, 10); // 75 min of exercise
    });

    it('without a device active figure it is the same as static: workouts need the day total to be counted', () => {
      const withWorkouts = computeExpenditure({ ...day, manualExerciseKcal: 100, exerciseMinutes: 30, deviceWorkoutKcal: 500 });
      const asStatic = computeExpenditure({ ...day, mode: 'static', manualExerciseKcal: 100, exerciseMinutes: 30 });
      expect(withWorkouts).toEqual({ ...asStatic, mode: 'device_adjusted' });
    });

    it('a small, partial-day device total never drops the total below bmr + baseline - the baseline spent on exercise', () => {
      for (const minutes of [0, 30, 60, 150]) {
        const lostToExerciseTime = (279 / 16) * (minutes / 60);
        for (const tracker of [0, 1, 50, 150, 278, 279]) {
          const r = computeExpenditure({
            ...day,
            deviceActiveKcal: tracker,
            exerciseMinutes: minutes,
            deviceDayComplete: false,
          });
          expect(r.total).toBeGreaterThanOrEqual(1394 + 279 - lostToExerciseTime - 1e-9);
          // while the baseline is not used up, the tracker only moves kcal from the baseline to tracker activity
          if (tracker + lostToExerciseTime <= 279) expect(r.total).toBeCloseTo(1394 + 279 - lostToExerciseTime, 9);
          // once it is used up the tracker activity itself keeps the total from falling
          else expect(r.total).toBeCloseTo(1394 + tracker, 9);
        }
      }
    });

    it('stays at or above bmr + baseline - baseline lost to exercise time once exercise kcal count too', () => {
      const r = computeExpenditure({ ...day, deviceActiveKcal: 5, deviceWorkoutKcal: 0, manualExerciseKcal: 200, exerciseMinutes: 40 });
      expect(r.total).toBeGreaterThanOrEqual(1394 + 279 - (279 / 16) * (40 / 60));
    });
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
      baselineKcal: 356,
      adjustedBaseline: 0,
      trackerActivity: 700,
      exercise: 0,
      tef: 200,
      total: 2750, // unchanged
      aboveBaseline: 414, // 1850 + 700 - (our bmr 1780 + baseline 356)
      baselineActivity: 0,
      deviceAboveBaseline: 700,
    });
  });

  it('device_total splits the device active energy into tracker activity and workouts without changing the total', () => {
    const r = computeExpenditure({
      ...base,
      mode: 'device_total',
      deviceActiveKcal: 700,
      deviceRestingKcal: 1850,
      deviceWorkoutKcal: 450,
    });
    expect(r.exercise).toBe(450);
    expect(r.trackerActivity).toBe(250);
    expect(r.total).toBe(2750);
    // workouts larger than the day's active energy (a device that reports workout totals incl. rest) are capped
    const capped = computeExpenditure({
      ...base,
      mode: 'device_total',
      deviceActiveKcal: 400,
      deviceRestingKcal: 1850,
      deviceWorkoutKcal: 450,
    });
    expect(capped.exercise).toBe(400);
    expect(capped.trackerActivity).toBe(0);
    expect(capped.total).toBe(400 + 1850 + 200);
  });

  it('device_total falls back to our BMR when the device has no resting energy', () => {
    const r = computeExpenditure({ ...base, mode: 'device_total', deviceActiveKcal: 700 });
    expect(r.total).toBe(2680); // 700 + 1780 + 200
  });

  it('device_total falls back to baseline + manual exercise without active energy', () => {
    const r = computeExpenditure({ ...base, mode: 'device_total', deviceRestingKcal: 1850 });
    expect(r.total).toBe(2706); // 1850 + 356 + 300 + 200
    expect(r.adjustedBaseline).toBe(356);
    expect(r.exercise).toBe(300);
  });

  describe('a device day that is not finished (cumulative counters, e.g. Garmin resting 801 kcal at midday)', () => {
    const midday = { ...base, mode: 'device_total' as const, deviceActiveKcal: 150, deviceRestingKcal: 801 };

    it('device_total does not treat the resting-so-far as a whole day of BMR: our BMR stands in', () => {
      const r = computeExpenditure({ ...midday, deviceDayComplete: false });
      expect(r).toMatchObject({
        mode: 'device_total',
        bmr: 1780, // not 801
        adjustedBaseline: 0,
        trackerActivity: 150,
        exercise: 0,
        tef: 200,
        total: 2130, // 1780 + 150 + 200
        aboveBaseline: 0,
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
      expect(r.adjustedBaseline).toBe(0);
      expect(r.exercise).toBe(0); // manual 300 and baseline 356 are not added on top of the device's active energy
      expect(r.total).toBeCloseTo(r.bmr + r.trackerActivity + r.tef, 10);
    });

    it('static and device_adjusted ignore the flag (they never read resting energy)', () => {
      for (const mode of ['static', 'device_adjusted'] as const) {
        const a = computeExpenditure({ ...midday, mode, deviceDayComplete: false });
        const b = computeExpenditure({ ...midday, mode, deviceDayComplete: true });
        expect(a).toEqual(b);
      }
    });

    it('device_adjusted: tracker activity so far only takes over part of the baseline, so a partial day cannot under-count', () => {
      const early = computeExpenditure({ ...base, mode: 'device_adjusted', deviceActiveKcal: 150, deviceRestingKcal: 801, deviceDayComplete: false });
      // CHANGED: the 150 kcal of tracker activity used to be ignored below the baseline (deviceAboveBaseline 0) and the
      // baseline stayed whole. Now it REPLACES 150 kcal of the baseline: same total, the breakdown shows the tracker.
      expect(early.trackerActivity).toBe(150);
      expect(early.adjustedBaseline).toBe(206); // 356 - 150
      expect(early.bmr).toBe(1780);
      expect(early.total).toBe(2636);
    });
  });

  it('TEF is added in every mode', () => {
    for (const mode of ['static', 'device_adjusted', 'device_total'] as const) {
      const input: ExpenditureInput = { ...base, mode, deviceActiveKcal: 650, deviceRestingKcal: 1900, deviceWorkoutKcal: 200 };
      const without = computeExpenditure({ ...input, tefEnabled: false });
      const withTef = computeExpenditure(input);
      expect(withTef.tef, mode).toBe(200);
      expect(withTef.total - without.total, mode).toBe(200);
      // TEF is never part of the energy that widens the budget
      expect(withTef.aboveBaseline, mode).toBe(without.aboveBaseline);
    }
  });

  it('always satisfies total = bmr + adjustedBaseline + trackerActivity + exercise + tef (and the deprecated aliases)', () => {
    for (const mode of ['static', 'device_adjusted', 'device_total'] as const) {
      for (const deviceDayComplete of [true, false]) {
        for (const minutes of [0, 45, 600]) {
          const r = computeExpenditure({
            ...base,
            mode,
            deviceActiveKcal: 650,
            deviceWorkoutKcal: 200,
            deviceRestingKcal: 1900,
            exerciseMinutes: minutes,
            deviceDayComplete,
          });
          expect(r.total).toBeCloseTo(r.bmr + r.adjustedBaseline + r.trackerActivity + r.exercise + r.tef, 10);
          expect(r.total).toBeCloseTo(r.bmr + r.baselineActivity + r.exercise + r.deviceAboveBaseline + r.tef, 10);
          expect(r.aboveBaseline).toBeGreaterThanOrEqual(0);
          expect(r.adjustedBaseline).toBeGreaterThanOrEqual(0);
          expect(r.adjustedBaseline).toBeLessThanOrEqual(r.baselineKcal);
        }
      }
    }
  });

  it('clamps negative and non-finite inputs and never lets the adjusted baseline go negative', () => {
    const r = computeExpenditure({
      ...base,
      mode: 'device_adjusted',
      manualExerciseKcal: -50,
      deviceActiveKcal: -10,
      deviceWorkoutKcal: Number.NaN,
      exerciseMinutes: -30,
    });
    expect(r.exercise).toBe(0);
    expect(r.trackerActivity).toBe(0);
    expect(r.adjustedBaseline).toBe(356);
    expect(r.total).toBe(1780 + 356 + 200);

    // 30 hours of exercise would remove more than the whole baseline: it stops at 0
    const long = computeExpenditure({ ...base, exerciseMinutes: 30 * 60 });
    expect(long.adjustedBaseline).toBe(0);
    expect(long.total).toBe(1780 + 300 + 200);
    // device_adjusted: a NaN / missing device figure is "no device"
    const nan = computeExpenditure({ ...base, mode: 'device_adjusted', deviceActiveKcal: Number.NaN, deviceWorkoutKcal: 100 });
    expect(nan.trackerActivity).toBe(0);
    expect(nan.total).toBe(2636);
  });

  it('does not round: only the display does', () => {
    const r = computeExpenditure({
      ...base,
      mode: 'device_adjusted',
      bmr: 1523.4,
      baselineActivityKcal: 1523.4 * 0.375,
      manualExerciseKcal: 123.456,
      deviceActiveKcal: 77.7,
      deviceWorkoutKcal: 10.1,
      exerciseMinutes: 37,
      tefEnabled: false,
    });
    const baseline = 1523.4 * 0.375;
    const tracker = 77.7 - 10.1;
    const adjusted = baseline - tracker - (baseline / 16) * (37 / 60);
    expect(r.trackerActivity).toBeCloseTo(tracker, 12);
    expect(r.adjustedBaseline).toBeCloseTo(adjusted, 12);
    expect(r.total).toBeCloseTo(1523.4 + adjusted + tracker + 10.1 + 123.456, 10);
    expect(Number.isInteger(r.total)).toBe(false);
  });

  it('uses a custom TEF percentage', () => {
    expect(computeExpenditure({ ...base, tefPct: 0.05 }).tef).toBeCloseTo(100, 10);
  });
});

describe('adjustedBaselineKcal', () => {
  it('is the baseline minus tracker activity minus 1/16 of it per hour of exercise, never below 0', () => {
    expect(AWAKE_HOURS).toBe(16);
    expect(adjustedBaselineKcal(279, 0, 0)).toBe(279);
    expect(adjustedBaselineKcal(279, 0, 60)).toBe(261.5625);
    expect(adjustedBaselineKcal(279, 100, 0)).toBe(179);
    expect(adjustedBaselineKcal(279, 100, 120)).toBeCloseTo(279 - 100 - 34.875, 12);
    expect(adjustedBaselineKcal(279, 279, 0)).toBe(0);
    expect(adjustedBaselineKcal(279, 1000, 0)).toBe(0);
    expect(adjustedBaselineKcal(279, 0, 16 * 60)).toBe(0); // 16 hours of exercise use up all of it
    expect(adjustedBaselineKcal(279, 0, 99 * 60)).toBe(0);
    expect(adjustedBaselineKcal(0, 10, 10)).toBe(0);
    expect(adjustedBaselineKcal(-5, 0, 0)).toBe(0);
  });
});

describe('energyRemaining and the third circle', () => {
  it("Target = (target + above baseline) - consumed, Balance = expenditure - consumed (Cronometer's example)", () => {
    const r = energyRemaining({ targetKcal: 1673, aboveBaselineKcal: 482.5625, expenditureKcal: 2155.5625, consumedKcal: 1800 });
    expect(r.target).toBe(1673 + 482.5625 - 1800);
    expect(r.target).toBe(355.5625);
    expect(r.balance).toBe(355.5625);
  });

  it('they differ for a weight-loss goal: Target keeps the deficit in the budget, Balance shows the plain deficit', () => {
    // target 1861 (maintenance 2136 - 275), expenditure 2136 + 0 above baseline, ate 1700
    const r = energyRemaining({ targetKcal: 1861, aboveBaselineKcal: 0, expenditureKcal: 2136, consumedKcal: 1700 });
    expect(r.target).toBe(161);
    expect(r.balance).toBe(436);
  });

  it('Balance includes TEF while Target does not', () => {
    // expenditure 2336 = 2136 + 200 TEF
    const r = energyRemaining({ targetKcal: 2136, aboveBaselineKcal: 0, expenditureKcal: 2336, consumedKcal: 2000 });
    expect(r.target).toBe(136);
    expect(r.balance).toBe(336);
  });

  it('goes negative when over the budget / in surplus; a negative above-baseline never reduces the target', () => {
    expect(energyRemaining({ targetKcal: 2000, aboveBaselineKcal: 0, expenditureKcal: 2100, consumedKcal: 2300 })).toEqual({
      target: -300,
      balance: -200,
    });
    expect(energyRemaining({ targetKcal: 2000, aboveBaselineKcal: -50, expenditureKcal: 2000, consumedKcal: 0 }).target).toBe(2000);
  });

  it('names the circle', () => {
    expect(energySummaryCaption('target', 10)).toBe('Remaining');
    expect(energySummaryCaption('target', 0)).toBe('Remaining');
    expect(energySummaryCaption('target', -1)).toBe('Over');
    expect(energySummaryCaption('target', undefined)).toBe('Remaining');
    expect(energySummaryCaption('balance', 10)).toBe('Deficit');
    expect(energySummaryCaption('balance', -1)).toBe('Surplus');
    expect(energySummaryCaption('balance', undefined)).toBe('Balance');
    expect(DEFAULT_ENERGY_SUMMARY_MODE).toBe('target');
  });

  it('toggles and normalises the stored mode', () => {
    expect(nextEnergySummaryMode('target')).toBe('balance');
    expect(nextEnergySummaryMode('balance')).toBe('target');
    expect(normalizeEnergySummaryMode('balance')).toBe('balance');
    for (const v of ['target', 'remaining', '', null, undefined, 3]) expect(normalizeEnergySummaryMode(v)).toBe('target');
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
      tefPct: 0,
      tefAllowance: 0,
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

describe('activity level "none" (the watch is the only source of activity)', () => {
  const bmr = 1800;
  const input = (level: 'none' | 'sedentary', over: Partial<ExpenditureInput> = {}): ExpenditureInput => ({
    mode: 'device_adjusted',
    bmr,
    baselineActivityKcal: baselineActivityKcal(bmr, level),
    manualExerciseKcal: 0,
    intakeKcal: 0,
    tefEnabled: false,
    ...over,
  });

  it('adds nothing for everyday movement: without a device the day is just the resting burn', () => {
    const r = computeExpenditure(input('none'));
    expect(r.total).toBe(bmr);
    expect(r.aboveBaseline).toBe(0);
  });

  it('every kcal the watch records counts, because there is no baseline for it to replace', () => {
    // 300 kcal of walking + a one hour, 600 kcal workout recorded by the watch
    const r = computeExpenditure(input('none', { deviceActiveKcal: 900, deviceWorkoutKcal: 600, exerciseMinutes: 60 }));
    expect(r.adjustedBaseline).toBe(0);
    expect(r.trackerActivity).toBe(300);
    expect(r.total).toBe(bmr + 900);
    expect(r.aboveBaseline).toBe(900);
  });

  it('the budget is then the watch total minus the deficit, with a lower floor than any baseline level would give', () => {
    const none = computeExpenditure(input('none'));
    const sedentary = computeExpenditure(input('sedentary'));
    expect(none.total).toBeLessThan(sedentary.total);
    const watch = { deviceActiveKcal: 900, deviceWorkoutKcal: 600, exerciseMinutes: 60 };
    const withWatchNone = computeExpenditure(input('none', watch));
    const deficit = 550;
    const targetNone = bmr - deficit;
    expect(energyRemaining({ targetKcal: targetNone, aboveBaselineKcal: withWatchNone.aboveBaseline, expenditureKcal: withWatchNone.total, consumedKcal: 0 }).target).toBe(
      withWatchNone.total - deficit,
    );
  });
});

describe('activity level "none" (the watch is the only source of activity)', () => {
  const bmr = 1800;
  const input = (level: 'none' | 'sedentary', over: Partial<ExpenditureInput> = {}): ExpenditureInput => ({
    mode: 'device_adjusted',
    bmr,
    baselineActivityKcal: baselineActivityKcal(bmr, level),
    manualExerciseKcal: 0,
    intakeKcal: 0,
    tefEnabled: false,
    ...over,
  });

  it('adds nothing for everyday movement: without a device the day is just the resting burn', () => {
    const r = computeExpenditure(input('none'));
    expect(r.total).toBe(bmr);
    expect(r.aboveBaseline).toBe(0);
  });

  it('every kcal the watch records counts, because there is no baseline for it to replace', () => {
    // 300 kcal of walking + a one hour, 600 kcal workout recorded by the watch
    const r = computeExpenditure(input('none', { deviceActiveKcal: 900, deviceWorkoutKcal: 600, exerciseMinutes: 60 }));
    expect(r.adjustedBaseline).toBe(0);
    expect(r.trackerActivity).toBe(300);
    expect(r.total).toBe(bmr + 900);
    expect(r.aboveBaseline).toBe(900);
  });

  it('the budget is then the watch total minus the deficit, with a lower floor than any baseline level would give', () => {
    const none = computeExpenditure(input('none'));
    const sedentary = computeExpenditure(input('sedentary'));
    expect(none.total).toBeLessThan(sedentary.total);
    const watch = { deviceActiveKcal: 900, deviceWorkoutKcal: 600, exerciseMinutes: 60 };
    const withWatchNone = computeExpenditure(input('none', watch));
    const deficit = 550;
    const targetNone = bmr - deficit;
    expect(energyRemaining({ targetKcal: targetNone, aboveBaselineKcal: withWatchNone.aboveBaseline, expenditureKcal: withWatchNone.total, consumedKcal: 0 }).target).toBe(
      withWatchNone.total - deficit,
    );
  });
});

describe('budgetExtraKcal: what burning above the baseline adds to the budget', () => {
  it('is everything burned above the baseline when the floor did not raise the target', () => {
    expect(budgetExtraKcal(0, 0)).toBe(0);
    expect(budgetExtraKcal(482.5625, 0)).toBe(482.5625);
  });

  it('the first kcal only fill the gap to the minimum target; the rest widens the budget', () => {
    expect(budgetExtraKcal(100, 215)).toBe(0);
    expect(budgetExtraKcal(215, 215)).toBe(0);
    expect(budgetExtraKcal(934, 215)).toBe(719);
  });

  it('the budget is max(plan + burned, floor): the floor is a minimum, not a bonus on top of the activity', () => {
    // BMR 1835, no baseline, -550/day: plan 1285, floor 1500 (male), raised by 215
    const t = computeEnergyTarget({ bmr: 1835, baselineActivityKcal: 0, rateKgPerWeek: -0.5, sex: 'male' });
    expect(t.target).toBe(1500);
    expect(t.flooredBy).toBe(215);
    for (const burned of [0, 100, 215, 400, 934, 2000]) {
      expect(t.target + budgetExtraKcal(burned, t.flooredBy)).toBe(Math.max(t.maintenance + t.delta + burned, t.floor));
    }
  });

  it('never negative and tolerant of bad input', () => {
    expect(budgetExtraKcal(-50, 0)).toBe(0);
    expect(budgetExtraKcal(50, -20)).toBe(50);
    expect(budgetExtraKcal(Number.NaN, 10)).toBe(0);
  });
});

describe('the thermic effect of food (TEF) inside the target', () => {
  const TEF = 0.1;

  it('without TEF nothing changes: tefPct 0, no allowance', () => {
    const t = computeEnergyTarget({ bmr: 1835, baselineActivityKcal: 0, rateKgPerWeek: -0.5, sex: 'male', tefPct: 0 });
    expect(t).toMatchObject({ target: 1500, flooredBy: 215, tefPct: 0, tefAllowance: 0 });
  });

  it('allows for the digestion of the food: plan = (maintenance + delta) / (1 - tefPct)', () => {
    // maintenance 2136, delta -275 -> 1861 of net energy; the food that covers it is 1861 / 0.9
    const t = computeEnergyTarget({ bmr: 1780, baselineActivityKcal: 356, rateKgPerWeek: -0.25, sex: 'male', tefPct: TEF });
    expect(t.target).toBeCloseTo(1861 / 0.9, 9);
    expect(t.tefAllowance).toBeCloseTo(1861 / 0.9 - 1861, 9);
    expect(t.tefPct).toBe(TEF);
    expect(t.flooredBy).toBe(0);
    expect(t.maintenance).toBe(2136);
    expect(t.delta).toBe(-275);
  });

  it('the floor still applies to the grossed-up plan (BMR 1835, -550/day: plan 1285 / 0.9 = 1427.8, floor 1500)', () => {
    const t = computeEnergyTarget({ bmr: 1835, baselineActivityKcal: 0, rateKgPerWeek: -0.5, sex: 'male', tefPct: TEF });
    expect(t.target).toBe(1500);
    expect(t.tefAllowance).toBeCloseTo(1285 / 0.9 - 1285, 9);
    expect(t.flooredBy).toBeCloseTo(1500 - 1285 / 0.9, 9);
    expect(t.belowBmr).toBe(true);
  });

  it('ignores a nonsense share (negative, NaN, above 50%)', () => {
    expect(computeEnergyTarget({ bmr: 2000, baselineActivityKcal: 0, rateKgPerWeek: 0, sex: 'male', tefPct: -1 }).target).toBe(2000);
    expect(computeEnergyTarget({ bmr: 2000, baselineActivityKcal: 0, rateKgPerWeek: 0, sex: 'male', tefPct: Number.NaN }).target).toBe(2000);
    expect(computeEnergyTarget({ bmr: 2000, baselineActivityKcal: 0, rateKgPerWeek: 0, sex: 'male', tefPct: 0.9 }).target).toBe(4000);
  });

  it('foodForNetKcal: kcal / (1 - share), unchanged without a share', () => {
    expect(foodForNetKcal(900, 0.1)).toBeCloseTo(1000, 9);
    expect(foodForNetKcal(900, 0)).toBe(900);
    expect(foodForNetKcal(900, undefined)).toBe(900);
    expect(foodForNetKcal(900, null)).toBe(900);
  });

  it("budgetExtraKcal grows each burned kcal by 1 / (1 - share) before the floor's gap is taken off", () => {
    expect(budgetExtraKcal(430, 0, TEF)).toBeCloseTo(430 / 0.9, 9);
    expect(budgetExtraKcal(430, 100, TEF)).toBeCloseTo(430 / 0.9 - 100, 9);
    expect(budgetExtraKcal(50, 100, TEF)).toBe(0);
    // the old two-argument call is TEF off
    expect(budgetExtraKcal(430, 100)).toBe(330);
  });

  it("the user's day: target 1500, burned 430 above baseline, budget 1906; eating it leaves the 550 chosen", () => {
    const t = computeEnergyTarget({ bmr: 1835, baselineActivityKcal: 0, rateKgPerWeek: -0.5, sex: 'male', tefPct: TEF });
    const budget = t.target + budgetExtraKcal(430, t.flooredBy, t.tefPct);
    expect(budget).toBeCloseTo((1835 + 430 - 550) / 0.9, 9);
    expect(Math.round(budget)).toBe(1906);
    const day = computeExpenditure({
      mode: 'static',
      bmr: 1835,
      baselineActivityKcal: 0,
      manualExerciseKcal: 430,
      exerciseMinutes: 0,
      deviceWorkoutKcal: 0,
      intakeKcal: budget,
      tefEnabled: true,
    });
    expect(day.aboveBaseline).toBe(430);
    expect(day.total - budget).toBeCloseTo(550, 9);
  });

  it('property: eating the budget leaves exactly the chosen deficit / surplus whenever the floor does not apply', () => {
    for (const sex of ['male', 'female'] as const) {
      for (const bmr of [1300, 1650, 1835, 2300]) {
        for (const level of ['none', 'sedentary', 'moderate'] as const) {
          for (const rate of [-1, -0.5, -0.25, 0, 0.25, 0.5]) {
            for (const burned of [0, 150, 430, 1200]) {
              const baseline = baselineActivityKcal(bmr, level);
              const t = computeEnergyTarget({ bmr, baselineActivityKcal: baseline, rateKgPerWeek: rate, sex, tefPct: TEF });
              const budget = t.target + budgetExtraKcal(burned, t.flooredBy, t.tefPct);
              const plan = (bmr + baseline + dailyDeltaFromRate(rate) + burned) / 0.9;
              expect(budget).toBeCloseTo(Math.max(plan, t.floor), 9);
              if (plan <= t.floor) continue;
              const day = computeExpenditure({
                mode: 'static',
                bmr,
                baselineActivityKcal: baseline,
                manualExerciseKcal: burned,
                exerciseMinutes: 0,
                deviceWorkoutKcal: 0,
                intakeKcal: budget,
                tefEnabled: true,
              });
              expect(day.total - budget).toBeCloseTo(-dailyDeltaFromRate(rate), 9);
            }
          }
        }
      }
    }
  });
});
