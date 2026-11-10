import { describe, expect, it } from 'vitest';

import {
  FRESH_DAYS,
  computeCoachFindings,
  computeNutrientRows,
  computeUnavailable,
  formatFinding,
  slopeKgPerWeek,
  type CoachFinding,
  type FindingsInput,
  type FindingsIntakeDay,
} from './coach-findings';

const TODAY = '2026-11-10';

/** The date `n` days before TODAY. */
function ago(n: number): string {
  return new Date(Date.UTC(2026, 10, 10) - n * 86_400_000).toISOString().slice(0, 10);
}

/** Completed, logged days 1..n days ago with the same values (overridable per day). */
function days(n: number, over: Partial<FindingsIntakeDay> | ((i: number) => Partial<FindingsIntakeDay>) = {}): FindingsIntakeDay[] {
  return Array.from({ length: n }, (_, k) => {
    const i = k + 1;
    return {
      date: ago(i),
      kcal: 2000,
      proteinG: 120,
      carbsG: 200,
      fatG: 70,
      fiberG: 25,
      ...(typeof over === 'function' ? over(i) : over),
    };
  });
}

const find = (list: CoachFinding[], kind: string) => list.find((f) => f.kind === kind);

const BASE: FindingsInput = {
  today: TODAY,
  weightKg: 84.2,
  goal: { type: 'lose', weeklyRateKg: 0.5, targetWeightKg: 80 },
  targets: { kcal: 2100, proteinG: 150, fiberG: 30 },
};

describe('protein and calories', () => {
  it('protein below target is a watch with g, g/kg, the target and the basis', () => {
    const list = computeCoachFindings({ ...BASE, intake: days(7, { proteinG: 92 }) });
    const f = find(list, 'protein_vs_target')!;
    expect(f.tone).toBe('watch');
    expect(f.claim).toBe('Protein averages 92 g/day against a 150 g target (61%).');
    expect(f.evidence).toEqual(
      expect.arrayContaining(['average 92 g/day', '1.09 g/kg at 84.2 kg', 'target 1.78 g/kg', 'target 150 g', '61% of target', '0 of 7 days at 90% of target or more']),
    );
    expect(f.basis).toMatch(/^7 logged days of the last 7/);
  });

  it('protein on target is good news, mid-way is a note', () => {
    expect(find(computeCoachFindings({ ...BASE, intake: days(7, { proteinG: 150 }) }), 'protein_vs_target')).toMatchObject({ tone: 'good' });
    expect(find(computeCoachFindings({ ...BASE, intake: days(7, { proteinG: 130 }) }), 'protein_vs_target')).toMatchObject({ tone: 'note' });
  });

  it('days without a log are not counted as zero: 5 logged days average over 5', () => {
    const intake = [1, 2, 4, 5, 7].map((i) => ({ date: ago(i), kcal: 2000, proteinG: 100 }));
    const f = find(computeCoachFindings({ ...BASE, intake }), 'protein_vs_target')!;
    expect(f.claim).toContain('100 g/day');
    expect(f.basis).toMatch(/^5 logged days of the last 7/);
  });

  it('with fewer than 3 logged days nothing is said about averages', () => {
    const list = computeCoachFindings({ ...BASE, intake: days(2), lastLoggedDate: ago(1) });
    expect(find(list, 'protein_vs_target')).toBeUndefined();
    expect(find(list, 'calories_vs_target')).toBeUndefined();
  });

  it('falls back to the last 14 days when the last 7 hold too few logged days', () => {
    const intake = [...[1, 2].map((i) => ({ date: ago(i), kcal: 2000, proteinG: 100 })), ...[9, 10, 11, 12].map((i) => ({ date: ago(i), kcal: 2000, proteinG: 100 }))];
    const f = find(computeCoachFindings({ ...BASE, intake }), 'protein_vs_target')!;
    expect(f.basis).toMatch(/^6 logged days of the last 14/);
  });

  it('calories: on target is good, far above is a watch, far below is a watch, slightly off is a note', () => {
    const tone = (kcal: number, goal: FindingsInput['goal'] = BASE.goal) =>
      find(computeCoachFindings({ ...BASE, goal, intake: days(7, { kcal }) }), 'calories_vs_target')!.tone;
    expect(tone(2100)).toBe('good');
    expect(tone(2200)).toBe('good'); // +4.8%
    expect(tone(2300)).toBe('note'); // +9.5%
    expect(tone(2500)).toBe('watch'); // +19%
    expect(tone(1900)).toBe('note'); // -9.5%
    expect(tone(1600)).toBe('watch'); // -24%
    // when the goal is to gain, eating above target is not alarming
    expect(tone(2500, { type: 'gain', weeklyRateKg: 0.3 })).toBe('note');
  });

  it('calories finding quotes average, target, difference, days over and the macro split', () => {
    const f = find(computeCoachFindings({ ...BASE, intake: days(7, (i) => ({ kcal: i <= 3 ? 2600 : 2000 })) }), 'calories_vs_target')!;
    expect(f.claim).toBe('Calories average 2257 kcal/day against a 2100 kcal target: above target (+157 kcal).');
    expect(f.evidence).toContain('+157 kcal (+7%)');
    expect(f.evidence).toContain('3 of 7 days over target');
    expect(f.evidence).toContain('lowest day 2000, highest 2600 kcal');
    expect(f.evidence.some((e) => /^share of kcal: \d+% protein \/ \d+% carbs \/ \d+% fat$/.test(e))).toBe(true);
  });

  it('fiber: low is reported, near target stays quiet', () => {
    expect(find(computeCoachFindings({ ...BASE, intake: days(7, { fiberG: 12 }) }), 'fiber_vs_target')).toMatchObject({ tone: 'watch' });
    expect(find(computeCoachFindings({ ...BASE, intake: days(7, { fiberG: 28 }) }), 'fiber_vs_target')).toBeUndefined();
    expect(find(computeCoachFindings({ ...BASE, intake: days(7, { fiberG: 32 }) }), 'fiber_vs_target')).toMatchObject({ tone: 'good' });
  });
});

describe('logging', () => {
  it('a food log that stopped days ago is the top finding, and says the numbers are not current', () => {
    const list = computeCoachFindings({ ...BASE, intake: days(7).map((d, i) => ({ ...d, date: ago(i + 4) })), lastLoggedDate: ago(4) });
    expect(list[0]).toMatchObject({ kind: 'logging_gap', tone: 'watch' });
    expect(list[0]!.claim).toContain('4 days ago');
  });

  it('logged yesterday: no gap', () => {
    expect(find(computeCoachFindings({ ...BASE, intake: days(7), lastLoggedDate: ago(0) }), 'logging_gap')).toBeUndefined();
  });

  it('sparse logging is flagged, a long streak is praised', () => {
    expect(find(computeCoachFindings({ ...BASE, intake: days(14).filter((_, i) => i % 2 === 0) }), 'logging_coverage')).toMatchObject({
      claim: 'Food was logged on only 7 of the last 14 days, so the averages may not match what you really ate.',
    });
    expect(find(computeCoachFindings({ ...BASE, intake: days(10) }), 'logging_streak')).toMatchObject({ tone: 'good', claim: 'You have logged food 10 days in a row.' });
  });

  it('nothing logged at all', () => {
    const list = computeCoachFindings({ ...BASE });
    expect(find(list, 'no_intake_data')).toBeDefined();
    expect(computeUnavailable({ ...BASE })).toContain('food intake (nothing logged on the last 14 completed days)');
  });
});

describe('micronutrients', () => {
  const nutrientTargets = {
    MAGNESIUM_MG: { min: 400 },
    VITAMIN_D_UG: { min: 15 },
    CALCIUM_MG: { min: 1000 },
    POTASSIUM_MG: { min: 3400 },
    SODIUM_MG: { max: 2300 },
    VITAMIN_C_MG: { min: 90, max: 2000 },
    PROTEIN_G: { min: 150 }, // macros are handled elsewhere
  };

  it('lists nutrients consistently under 70% of target, lowest first, with names, amounts and percentages', () => {
    const intake = days(7, { nutrients: { MAGNESIUM_MG: 212, VITAMIN_D_UG: 5, CALCIUM_MG: 1000, POTASSIUM_MG: 2000, VITAMIN_C_MG: 100, PROTEIN_G: 10 } });
    const f = find(computeCoachFindings({ ...BASE, intake, nutrientTargets }), 'micronutrient_gaps')!;
    expect(f.claim).toBe('Consistently below 70% of target: Vitamin D 33% (5 of 15 ug), Magnesium 53% (212 of 400 mg), Potassium 59% (2000 of 3400 mg).');
    expect(f.tone).toBe('watch'); // vitamin D under 40%
    expect(f.evidence[0]).toBe('Vitamin D: 5 ug/day average, 7 of 7 days under 70%');
    expect(f.basis).toContain('7 logged days of the last 7');
    expect(f.basis).toContain('incomplete food data');
  });

  it('shows at most the 5 lowest', () => {
    const codes = ['MAGNESIUM_MG', 'VITAMIN_D_UG', 'CALCIUM_MG', 'POTASSIUM_MG', 'IRON_MG', 'ZINC_MG', 'SELENIUM_UG'] as const;
    const targets = Object.fromEntries(codes.map((c) => [c, { min: 100 }]));
    const nutrients = Object.fromEntries(codes.map((c, i) => [c, 10 + i * 5]));
    const f = find(computeCoachFindings({ ...BASE, intake: days(7, { nutrients }), nutrientTargets: targets }), 'micronutrient_gaps')!;
    expect(f.evidence).toHaveLength(5);
    expect(f.claim).toContain('Magnesium 10%');
    expect(f.claim).not.toContain('Zinc');
  });

  it('a nutrient no food had data for is unknown, not zero', () => {
    // magnesium present on only 2 of 7 days: not enough days with data, so no (false) gap is reported
    const intake = days(7, (i): Partial<FindingsIntakeDay> => (i <= 2 ? { nutrients: { MAGNESIUM_MG: 50 } } : { nutrients: { CALCIUM_MG: 1000 } }));
    const list = computeCoachFindings({ ...BASE, intake, nutrientTargets });
    expect(find(list, 'micronutrient_gaps')).toBeUndefined();
  });

  it('an average that is low only because of a few days is not "consistent"', () => {
    const intake = days(7, (i) => ({ nutrients: { MAGNESIUM_MG: i <= 2 ? 0 : 390 } })); // avg 278 = 69%, but 2 of 7 days low
    expect(find(computeCoachFindings({ ...BASE, intake, nutrientTargets }), 'micronutrient_gaps')).toBeUndefined();
  });

  it('reports upper limits that are exceeded on average (sodium from the dedicated field too)', () => {
    const f = find(
      computeCoachFindings({ ...BASE, intake: days(7, { sodiumMg: 3400, nutrients: { VITAMIN_C_MG: 2500 } }), nutrientTargets }),
      'limits_exceeded',
    )!;
    expect(f.tone).toBe('watch');
    expect(f.claim).toBe('Above the daily upper limit on average: Sodium 148% (3400 of 2300 mg), Vitamin C 125% (2500 of 2000 mg).');
  });

  it('nutrient rows for the data block: furthest below the minimum first, then over the limit', () => {
    const rows = computeNutrientRows({ ...BASE, intake: days(7, { sodiumMg: 3400, nutrients: { MAGNESIUM_MG: 212, VITAMIN_D_UG: 5, CALCIUM_MG: 1200 } }), nutrientTargets });
    expect(rows.map((r) => r.name)).toEqual(['Vitamin D', 'Magnesium', 'Sodium']);
    expect(rows[0]).toMatchObject({ unit: 'ug', avg: 5, min: 15, days: 7 });
    expect(rows[0]!.pctOfMin).toBeCloseTo(0.333, 2);
  });
});

describe('weight', () => {
  const series = (kgPerWeek: number, weeks = 4, start = 85) =>
    Array.from({ length: weeks * 7 + 1 }, (_, i) => ({ date: ago(weeks * 7 - i), kg: start + (kgPerWeek * i) / 7 })).filter((_, i) => i % 3 === 0);

  it('on the planned pace is good news with the ETA to the target weight', () => {
    const f = find(computeCoachFindings({ ...BASE, weightPoints: series(-0.5) }), 'weight_trend')!;
    expect(f.tone).toBe('good');
    expect(f.claim).toMatch(/^Weight trend is -0\.5 kg\/week \(on the planned pace\), now 8\d\.\d kg\.$/);
    expect(f.evidence).toContain('planned -0.5 kg/week');
    expect(f.evidence.some((e) => /kg to the 80 kg target, about \d+ weeks at this pace/.test(e))).toBe(true);
  });

  it('slower than planned is a note, no change after 3+ weeks is a watch', () => {
    expect(find(computeCoachFindings({ ...BASE, weightPoints: series(-0.2) }), 'weight_trend')).toMatchObject({ tone: 'note' });
    expect(find(computeCoachFindings({ ...BASE, weightPoints: series(0.0) }), 'weight_trend')).toMatchObject({ tone: 'watch' });
  });

  it('losing faster than about 1% of body weight per week is flagged', () => {
    const f = find(computeCoachFindings({ ...BASE, goal: { type: 'lose', weeklyRateKg: 1 }, weightPoints: series(-1.1, 4, 90) }), 'weight_trend')!;
    expect(f.tone).toBe('watch');
    expect(f.claim).toContain('faster than about 1% of body weight per week');
  });

  it('a stale weigh-in says so and gives no trend', () => {
    const list = computeCoachFindings({ ...BASE, weightPoints: [{ date: ago(30), kg: 85 }, { date: ago(22), kg: 84.6 }, { date: ago(20), kg: 84.4 }] });
    expect(find(list, 'weight_stale')!.claim).toContain('20 days ago');
    expect(find(list, 'weight_trend')).toBeUndefined();
  });

  it('too few weigh-ins or too short a span: no trend', () => {
    expect(find(computeCoachFindings({ ...BASE, weightPoints: [{ date: ago(3), kg: 84 }, { date: ago(1), kg: 83.9 }] }), 'weight_trend')).toBeUndefined();
    expect(find(computeCoachFindings({ ...BASE, weightPoints: [ago(6), ago(4), ago(2), ago(0)].map((date, i) => ({ date, kg: 84 - i * 0.1 })) }), 'weight_trend')).toBeUndefined();
  });

  it('slopeKgPerWeek fits a straight line', () => {
    expect(slopeKgPerWeek([{ date: ago(14), kg: 86 }, { date: ago(7), kg: 85.5 }, { date: ago(0), kg: 85 }])).toBeCloseTo(-0.5, 5);
    expect(slopeKgPerWeek([{ date: ago(0), kg: 85 }])).toBeUndefined();
  });
});

describe('energy balance', () => {
  it('compares eaten with resting + active energy on days that have both', () => {
    const activity = Array.from({ length: 6 }, (_, k) => ({ date: ago(k + 1), activeKcal: 600 }));
    const f = find(computeCoachFindings({ ...BASE, bmrKcal: 1800, intake: days(6, { kcal: 2000 }), activity }), 'energy_balance')!;
    expect(f.claim).toBe('On days with food and watch data you ate about 2000 kcal and burned about 2400 (resting 1800 + active 600): -400 kcal/day, roughly -0.36 kg/week.');
    expect(f.basis).toContain('6 days with both a food log and watch active energy');
  });

  it('needs BMR and at least 4 matching days', () => {
    const activity = Array.from({ length: 3 }, (_, k) => ({ date: ago(k + 1), activeKcal: 600 }));
    expect(find(computeCoachFindings({ ...BASE, bmrKcal: 1800, intake: days(6), activity }), 'energy_balance')).toBeUndefined();
    expect(find(computeCoachFindings({ ...BASE, intake: days(6), activity: Array.from({ length: 6 }, (_, k) => ({ date: ago(k + 1), activeKcal: 600 })) }), 'energy_balance')).toBeUndefined();
  });
});

describe('sleep and recovery', () => {
  const nights = (hours: number[], newest = 0) => hours.map((h, i) => ({ date: ago(newest + i), hours: h }));

  it('sleep duration: short sleep is a watch with range and nights under 6 h', () => {
    const f = find(computeCoachFindings({ ...BASE, sleep: nights([5.5, 6, 6.2, 5, 7, 6.4, 6.1]) }), 'sleep_duration')!;
    expect(f.tone).toBe('watch');
    expect(f.claim).toBe('Sleep averages 6 h/night over the last week, short for recovery.');
    expect(f.evidence).toContain('2 nights under 6 h');
    expect(f.evidence).toContain('range 5 to 7 h');
    expect(f.basis).toBe('7 recorded nights of the last 7');
  });

  it('7+ hours is good news; 6.5 to 7 is a note', () => {
    expect(find(computeCoachFindings({ ...BASE, sleep: nights([7.5, 7.8, 7.2, 8]) }), 'sleep_duration')).toMatchObject({ tone: 'good' });
    expect(find(computeCoachFindings({ ...BASE, sleep: nights([6.8, 6.6, 6.9, 6.7]) }), 'sleep_duration')).toMatchObject({ tone: 'note' });
  });

  it('stale sleep data (the watch was not worn) does not produce a present-tense claim, and is listed as unavailable', () => {
    const input: FindingsInput = { ...BASE, sleep: nights([6, 6, 6, 6], FRESH_DAYS + 2) };
    expect(find(computeCoachFindings(input), 'sleep_duration')).toBeUndefined();
    expect(computeUnavailable(input).some((u) => u.startsWith('sleep (the newest night is'))).toBe(true);
  });

  it('needs 3 nights', () => {
    expect(find(computeCoachFindings({ ...BASE, sleep: nights([5, 5]) }), 'sleep_duration')).toBeUndefined();
  });

  it('uneven sleep is a note', () => {
    const f = find(computeCoachFindings({ ...BASE, sleep: nights([5, 9, 5.5, 8.5, 6, 9, 5, 8]) }), 'sleep_consistency')!;
    expect(f.claim).toMatch(/^Sleep length is uneven: it varies by about \d\.\d h/);
  });

  it('HRV down is a watch, up is good, small changes are ignored; stale data is ignored', () => {
    const recovery = (recent: number, base: number, newest = 0) => [
      ...Array.from({ length: 7 }, (_, i) => ({ date: ago(newest + i), hrv: recent })),
      ...Array.from({ length: 14 }, (_, i) => ({ date: ago(newest + 7 + i), hrv: base })),
    ];
    const down = find(computeCoachFindings({ ...BASE, recovery: recovery(48, 56) }), 'hrv_trend')!;
    expect(down.tone).toBe('watch');
    expect(down.claim).toBe('HRV is down 14%: 48 ms this week against a 56 ms baseline.');
    expect(find(computeCoachFindings({ ...BASE, recovery: recovery(62, 56) }), 'hrv_trend')).toMatchObject({ tone: 'good' });
    expect(find(computeCoachFindings({ ...BASE, recovery: recovery(55, 56) }), 'hrv_trend')).toBeUndefined();
    expect(find(computeCoachFindings({ ...BASE, recovery: recovery(48, 56, 6) }), 'hrv_trend')).toBeUndefined();
  });

  it('resting heart rate up by 3+ bpm is a watch', () => {
    const recovery = [
      ...Array.from({ length: 7 }, (_, i) => ({ date: ago(i), restingHr: 56 })),
      ...Array.from({ length: 14 }, (_, i) => ({ date: ago(7 + i), restingHr: 51 })),
    ];
    expect(find(computeCoachFindings({ ...BASE, recovery }), 'resting_hr_trend')!.claim).toBe('Resting heart rate is 56 bpm this week, up 5 bpm from a 51 bpm baseline.');
  });
});

describe('training', () => {
  const w = (n: number, type = 'Strength training', minutes = 45, extra: object = {}) => ({ date: ago(n), workouts: [{ type, minutes, kcal: 250, ...extra }] });

  it('frequency over 7 and 28 days; 3+ sessions a week is good news', () => {
    const activity = [w(0), w(2), w(4), w(9), w(12), w(16), w(20), w(24)];
    const f = find(computeCoachFindings({ ...BASE, activity }), 'training_frequency')!;
    expect(f.tone).toBe('good');
    expect(f.claim).toBe('3 workouts in the last 7 days (135 min); the 28-day average is 2 a week.');
    expect(f.evidence[0]).toBe('3 sessions, 135 min, 750 kcal in the last 7 days');
  });

  it('a gap after a regular routine is a watch with the days since the last workout', () => {
    const activity = [w(9), w(11), w(14), w(18), w(22)];
    const f = find(computeCoachFindings({ ...BASE, activity }), 'training_gap')!;
    expect(f.tone).toBe('watch');
    expect(f.claim).toBe('No workout in the last 9 days (last: Strength training 9 days ago (2026-11-01)), after about 1.3 sessions a week before that.');
  });

  it('a training load spike is flagged (7 days against the 3 weeks before, like an acute:chronic ratio)', () => {
    const activity = [w(0, 'Run', 60), w(1, 'Run', 60), w(2, 'Run', 60), w(3, 'Run', 60), w(9, 'Run', 60), w(16, 'Run', 60), w(23, 'Run', 60)];
    const f = find(computeCoachFindings({ ...BASE, activity }), 'load_spike')!;
    expect(f.claim).toBe('Training time this week (240 min) is 4x your usual 60 min a week.');
    expect(f.tone).toBe('watch');
  });

  it('last workout: what is known, and "no heart-rate figure" when it is not', () => {
    const f = find(computeCoachFindings({ ...BASE, activity: [w(0)] }), 'last_workout')!;
    expect(f.claim).toBe('Last workout today: Strength training, 45 min, 250 kcal.');
    expect(f.evidence).toEqual(['no heart-rate figure is available for it']);
  });

  it('last workout with heart rate, and when detail is sent separately', () => {
    const withHr = find(computeCoachFindings({ ...BASE, activity: [w(1, 'Run', 30, { avgHr: 152, maxHr: 178 })] }), 'last_workout')!;
    expect(withHr.claim).toBe('Last workout yesterday: Run, 30 min, 250 kcal, avg HR 152, max HR 178.');
    expect(withHr.evidence).toEqual([]);
    const detail = find(computeCoachFindings({ ...BASE, hasWorkoutDetail: true, activity: [w(1)] }), 'last_workout')!;
    expect(detail.evidence).toEqual(['more detail (heart rate etc.) is in the workout section below']);
  });

  it('steps drop and hydration', () => {
    const activity = [
      ...Array.from({ length: 7 }, (_, i) => ({ date: ago(i), steps: 6000 })),
      ...Array.from({ length: 14 }, (_, i) => ({ date: ago(7 + i), steps: 9000 })),
    ];
    expect(find(computeCoachFindings({ ...BASE, activity }), 'steps_trend')!.claim).toBe('Daily steps are down 33%: 6000 this week against 9000 before.');

    const f = find(computeCoachFindings({ ...BASE, targets: { ...BASE.targets, waterMl: 2500 }, intake: days(7, { waterMl: 1500 }) }), 'hydration')!;
    expect(f.claim).toBe('Logged water averages 1500 ml/day against a 2500 ml target (60%).');
  });
});

describe('ranking and robustness', () => {
  it('orders by priority, important problems before good news, and caps the list', () => {
    const list = computeCoachFindings({
      ...BASE,
      intake: days(7, { proteinG: 80, kcal: 2100 }),
      sleep: [7.5, 7.6, 7.4, 7.8].map((h, i) => ({ date: ago(i), hours: h })),
      activity: [{ date: ago(0), workouts: [{ type: 'Run', minutes: 30 }] }],
    });
    const priorities = list.map((f) => f.priority);
    expect([...priorities].sort((a, b) => b - a)).toEqual(priorities);
    expect(list[0]!.kind).toBe('protein_vs_target');
    expect(computeCoachFindings({ ...BASE, intake: days(7, { proteinG: 80 }) }, { max: 1 })).toHaveLength(1);
  });

  it('never throws on garbage input and returns nothing without a valid date', () => {
    expect(computeCoachFindings({ today: 'nope' })).toEqual([]);
    expect(computeUnavailable({ today: 'nope' })).toEqual([]);
    const messy = computeCoachFindings({
      today: TODAY,
      weightKg: Number.NaN,
      targets: { kcal: Number.NaN, proteinG: 0 },
      intake: [{ date: 'x', kcal: Number.NaN }, { date: ago(1), kcal: Number.POSITIVE_INFINITY }],
      sleep: [{ date: 'bad', hours: 7 }],
      weightPoints: [{ date: ago(1), kg: Number.NaN }],
      activity: [{ date: ago(1), steps: Number.NaN, workouts: [{ type: 'x', minutes: Number.NaN }] }],
    });
    expect(Array.isArray(messy)).toBe(true);
    for (const f of messy) expect(JSON.stringify(f)).not.toMatch(/NaN|Infinity|undefined/);
  });

  it('every finding has a claim, a basis and a priority in range', () => {
    const list = computeCoachFindings({
      ...BASE,
      intake: days(14, { nutrients: { MAGNESIUM_MG: 100 }, sodiumMg: 3500, waterMl: 900 }),
      nutrientTargets: { MAGNESIUM_MG: { min: 400 }, SODIUM_MG: { max: 2300 } },
      weightPoints: [{ date: ago(28), kg: 86 }, { date: ago(14), kg: 85.4 }, { date: ago(0), kg: 84.9 }],
      sleep: [6, 5.5, 6.2, 6.4].map((h, i) => ({ date: ago(i), hours: h })),
      activity: [{ date: ago(0), steps: 5000, workouts: [{ type: 'Run', minutes: 30 }] }],
    });
    expect(list.length).toBeGreaterThan(5);
    for (const f of list) {
      expect(f.claim.length).toBeGreaterThan(10);
      expect(f.basis.length).toBeGreaterThan(3);
      expect(f.priority).toBeGreaterThanOrEqual(0);
      expect(f.priority).toBeLessThanOrEqual(100);
      expect(['good', 'note', 'watch']).toContain(f.tone);
    }
    expect(new Set(list.map((f) => f.kind)).size).toBe(list.length);
  });

  it('formatFinding keeps tone, claim, evidence and basis in one line', () => {
    const f = computeCoachFindings({ ...BASE, intake: days(7, { proteinG: 92 }) }).find((x) => x.kind === 'protein_vs_target')!;
    const line = formatFinding(f);
    expect(line.startsWith('[watch] Protein averages 92 g/day')).toBe(true);
    expect(line).toContain('Counted: 7 logged days');
    expect(line).not.toContain('\n');
  });
});

describe('what the app cannot see', () => {
  it('lists the gaps so the model can say so instead of guessing', () => {
    const list = computeUnavailable({ today: TODAY });
    expect(list).toEqual([
      'food intake (nothing logged on the last 14 completed days)',
      'weight (no weigh-ins in the last 6 weeks)',
      'sleep (no recorded nights in the last 14 days)',
      'HRV',
      'resting heart rate',
      'workouts (none recorded in the last 28 days)',
    ]);
  });

  it('says that workouts only have duration and calories when no heart rate is anywhere', () => {
    const list = computeUnavailable({ ...BASE, intake: days(7), activity: [{ date: ago(0), workouts: [{ type: 'Run', minutes: 30 }] }] });
    expect(list).toContain('heart rate and effort of workouts (only duration and calories are recorded)');
    const withDetail = computeUnavailable({ ...BASE, hasWorkoutDetail: true, intake: days(7), activity: [{ date: ago(0), workouts: [{ type: 'Run', minutes: 30 }] }] });
    expect(withDetail.some((u) => u.startsWith('heart rate'))).toBe(false);
  });
});
