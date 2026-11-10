/**
 * The pure parts of the Workouts section (apps/app/src/components/workouts/*.ts, ai/workout-context-text.ts), run through the app's own
 * modules via the `@/` alias: what kind a workout is, the numbers and sentences (duration, pace, zones, strength sets), the week / month
 * grouping and the source filters of the list, the rows of the detail screen, and the text the coach gets.
 */
import { parseWorkoutDetails } from '../../../packages/garmin/src';
import { describe, expect, it } from 'vitest';

import { GARMIN_RUN_SUMMARY, GARMIN_STRENGTH_DETAILS, IDS, TODAY, buildFixtures } from './fixtures';

/** App modules are untyped here on purpose (this package's tsconfig knows nothing about React Native). */
const load = (specifier: string): Promise<any> => import(/* @vite-ignore */ specifier);

const rows = (name: string) => (buildFixtures().seed.tables[name] ?? []) as Record<string, any>[];

/** A fixture exercise row as the detail screen's WorkoutEntry. */
function entryOf(id: string) {
  const r = rows('exercise_entries').find((e) => e.id === id) as Record<string, any>;
  return { ...r, minutes: r.minutes, kcal: Number(r.kcal), details: parseWorkoutDetails(r.details) };
}

/** A local-time ISO string (the phone's clock), so clock texts do not depend on the time zone of the machine running the tests. */
const localAt = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();

describe('components/workouts/kinds.ts', () => {
  it('knows the kind from the Garmin type key, the MET activity code, then the name', async () => {
    const { workoutKind } = await load('@/components/workouts/kinds');
    expect(workoutKind({ name: 'Anything', type_key: 'strength_training' })).toBe('strength');
    expect(workoutKind({ name: 'Anything', type_key: 'treadmill_running' })).toBe('running');
    expect(workoutKind({ name: 'Anything', type_key: 'indoor_cycling' })).toBe('cycling');
    expect(workoutKind({ name: 'Anything', type_key: 'lap_swimming' })).toBe('swimming');
    expect(workoutKind({ name: 'Anything', type_key: 'hiking' })).toBe('hiking');
    expect(workoutKind({ name: 'Anything', type_key: 'indoor_rowing' })).toBe('rowing');
    expect(workoutKind({ name: 'Anything', type_key: 'yoga' })).toBe('yoga');
    expect(workoutKind({ name: 'Running, treadmill, general', activity_code: 'RUN_TREADMILL' })).toBe('running');
    expect(workoutKind({ name: 'x', activity_code: 'WALK_BRISK' })).toBe('walking');
    expect(workoutKind({ name: 'Traditional Strength Training' })).toBe('strength');
    expect(workoutKind({ name: 'Walking, brisk (3.5 mph / 5.6 km/h)' })).toBe('walking');
    expect(workoutKind({ name: 'Cycling, general' })).toBe('cycling');
    expect(workoutKind({ name: 'Padel' })).toBe('other');
    expect(workoutKind({ name: '' })).toBe('other');
  });

  it('the type key beats a misleading name', async () => {
    const { workoutKind } = await load('@/components/workouts/kinds');
    expect(workoutKind({ name: 'Strength run', type_key: 'running' })).toBe('running');
  });

  it('counts the kinds of the loaded rows (the type filter) and filters by them', async () => {
    const { availableKinds, filterByKind } = await load('@/components/workouts/kinds');
    const list = rows('exercise_entries').map((r) => ({ name: r.name, activity_code: r.activity_code, type_key: r.details?.typeKey ?? null }));
    const kinds = availableKinds(list) as { kind: string; count: number }[];
    expect(kinds.map((k) => k.kind).sort()).toEqual(['cycling', 'running', 'strength', 'walking']);
    expect(kinds.find((k) => k.kind === 'strength')?.count).toBe(2);
    expect(filterByKind(list, 'running')).toHaveLength(2);
    expect(filterByKind(list, 'all')).toHaveLength(list.length);
    expect(filterByKind(list, 'yoga')).toEqual([]);
  });

  it('picks the last three workouts of the same kind BEFORE the current one, newest first', async () => {
    const { selectComparable } = await load('@/components/workouts/kinds');
    const w = (id: string, date: string, time: string | null, name = 'Running, treadmill, general') => ({ id, name, activity_code: null, type_key: null, entry_date: date, started_at: time ? `${date}T${time}:00+01:00` : null });
    const current = w('cur', '2026-11-10', '07:00');
    const candidates = [
      current,
      w('later', '2026-11-10', '09:00'), // after the current one
      w('a', '2026-11-09', '07:00'),
      w('walk', '2026-11-09', '08:00', 'Walking, brisk'),
      w('b', '2026-11-05', '07:00'),
      w('c', '2026-11-01', null), // no start time: noon of its day
      w('d', '2026-10-20', '07:00'),
    ];
    expect(selectComparable(current, candidates, 3).map((x: { id: string }) => x.id)).toEqual(['a', 'b', 'c']);
    expect(selectComparable(current, [current, w('x', '2026-11-11', '07:00')], 3)).toEqual([]);
  });
});

describe('components/workouts/format.ts', () => {
  it('durations', async () => {
    const { formatDuration, formatMinutes, formatZoneTime } = await load('@/components/workouts/format');
    expect(formatDuration(40)).toBe('40 s');
    expect(formatDuration(59.6)).toBe('1 min');
    expect(formatDuration(60)).toBe('1 min');
    expect(formatDuration(2700)).toBe('45 min');
    expect(formatDuration(3725)).toBe('1 h 02 min');
    expect(formatDuration(7200)).toBe('2 h 00 min');
    expect(formatDuration(-5)).toBe('-');
    expect(formatDuration(null)).toBe('-');
    expect(formatMinutes(50)).toBe('50 min');
    expect(formatMinutes(75.4)).toBe('1 h 15 min');
    expect(formatMinutes(null)).toBe('-');
    expect(formatZoneTime(0)).toBe('0 min');
    expect(formatZoneTime(20)).toBe('<1 min');
    expect(formatZoneTime(90)).toBe('2 min');
    expect(formatZoneTime(1260)).toBe('21 min');
  });

  it('distance, pace, speed and climb in both unit systems', async () => {
    const f = await load('@/components/workouts/format');
    expect(f.formatDistance(5012.4)).toBe('5.01 km');
    expect(f.formatDistance(850)).toBe('850 m');
    expect(f.formatDistance(5000, 'imperial')).toBe('3.11 mi');
    expect(f.formatPace(360)).toBe('6:00 /km');
    expect(f.formatPace(365)).toBe('6:05 /km');
    expect(f.formatPace(360, 'imperial')).toBe('9:39 /mi');
    expect(f.formatSpeed(2.7778)).toBe('10 km/h');
    expect(f.formatSpeed(7.5)).toBe('27 km/h');
    expect(f.formatSpeed(7.5, 'imperial')).toBe('16.8 mph');
    expect(f.formatElevation(38)).toBe('38 m');
    expect(f.formatElevation(38, 'imperial')).toBe('125 ft');
    expect(f.formatHr(117.6)).toBe('118 bpm');
    expect([30, 90, 179, 180, 240].map(f.formatRest)).toEqual(['30 s', '90 s', '179 s', '3 min', '4 min']);
    expect([0, 59.6, 360, 3735].map(f.formatClockDuration)).toEqual(['0:00', '1:00', '6:00', '1:02:15']);
    expect(f.formatKcal(1245.4)).toBe('1,245 kcal');
  });

  it('only believable heart rates are shown', async () => {
    const { plausibleHr } = await load('@/components/workouts/format');
    expect(plausibleHr(128)).toBe(128);
    expect(plausibleHr(127.6)).toBe(128);
    for (const bad of [0, 24, 251, -3, Number.NaN, null, undefined, '120']) expect(plausibleHr(bad), String(bad)).toBeNull();
  });

  it('source labels and the filter chips (Apple Health on iOS and the web, Health Connect on Android)', async () => {
    const { sourceLabel, sourceFilters, sourcesOfFilter, matchesSourceFilter } = await load('@/components/workouts/format');
    expect(['garmin', 'apple_health', 'health_connect', 'manual', 'whatever'].map(sourceLabel)).toEqual(['Garmin', 'Apple Health', 'Health Connect', 'Manual', 'Manual']);
    expect(sourceFilters('ios').map((c: { label: string }) => c.label)).toEqual(['All', 'Garmin', 'Apple Health', 'Manual']);
    expect(sourceFilters('web').map((c: { label: string }) => c.label)).toEqual(['All', 'Garmin', 'Apple Health', 'Manual']);
    expect(sourceFilters('android').map((c: { label: string }) => c.label)).toEqual(['All', 'Garmin', 'Health Connect', 'Manual']);
    expect(sourcesOfFilter('all')).toBeNull();
    expect(sourcesOfFilter('garmin')).toEqual(['garmin']);
    expect(sourcesOfFilter('health')).toEqual(['apple_health', 'health_connect']);
    expect(sourcesOfFilter('manual')).toEqual(['manual']);
    expect(matchesSourceFilter('apple_health', 'health')).toBe(true);
    expect(matchesSourceFilter('health_connect', 'health')).toBe(true);
    expect(matchesSourceFilter('garmin', 'health')).toBe(false);
    expect(matchesSourceFilter('garmin', 'all')).toBe(true);
  });

  it('dates and times (the weekday comes from the calendar date, the clock from the phone)', async () => {
    const f = await load('@/components/workouts/format');
    expect(f.formatDayLabel('2026-11-10')).toBe('Tue 10 Nov');
    expect(f.formatDayLabel('2026-11-08')).toBe('Sun 8 Nov');
    expect(f.formatDayLabel('nonsense')).toBe('nonsense');
    expect(f.formatLongDate('2026-11-10')).toBe('Tuesday, 10 November 2026');
    expect(f.formatClockTime(localAt(2026, 11, 10, 7, 5))).toBe('07:05');
    expect(f.formatClockTime('garbage')).toBeNull();
    expect(f.formatClockTime(null)).toBeNull();
    expect(f.formatTimeRange(localAt(2026, 11, 10, 7), localAt(2026, 11, 10, 7, 45))).toBe('07:00\u201307:45');
    expect(f.formatTimeRange(localAt(2026, 11, 10, 7), null)).toBe('07:00');
    expect(f.formatTimeRange(null, localAt(2026, 11, 10, 7))).toBeNull();
    expect(f.formatWhen({ entry_date: '2026-11-10', started_at: localAt(2026, 11, 10, 7) })).toBe('Tue 10 Nov, 07:00');
    expect(f.formatWhen({ entry_date: '2026-11-10', started_at: null })).toBe('Tue 10 Nov');
  });

  it('the heart-rate zone bar: fractions add up to one, minutes per zone, all zones listed', async () => {
    const { zoneBar, zoneSummary } = await load('@/components/workouts/format');
    const bar = zoneBar(GARMIN_STRENGTH_DETAILS.hrZones);
    expect(bar.map((s: { label: string }) => s.label)).toEqual(['Z1 Warm-up', 'Z2 Easy', 'Z3 Aerobic', 'Z4 Threshold', 'Z5 Maximum']);
    expect(bar.map((s: { time: string }) => s.time)).toEqual(['7 min', '21 min', '15 min', '6 min', '1 min']);
    expect(bar.reduce((sum: number, s: { fraction: number }) => sum + s.fraction, 0)).toBeCloseTo(1, 10);
    expect(bar[1].fraction).toBeCloseTo(1260 / 3000, 10);
    expect(bar[1].lowBpm).toBe(114);
    expect(zoneSummary(GARMIN_STRENGTH_DETAILS.hrZones)).toBe('Z1 7 min, Z2 21 min, Z3 15 min, Z4 6 min, Z5 1 min');
    // out-of-order input, a zone without time, a sixth zone
    const odd = zoneBar([{ zone: 3, seconds: 60 }, { zone: 1, seconds: 0 }, { zone: 6, seconds: 60 }]);
    expect(odd.map((s: { zone: number }) => s.zone)).toEqual([1, 3, 6]);
    expect(odd[0].time).toBe('0 min');
    expect(odd[2].name).toBe('Zone 6');
    expect(zoneBar(undefined)).toEqual([]);
    expect(zoneBar([])).toEqual([]);
    expect(zoneBar([{ zone: 1, seconds: 0 }])).toEqual([]);
  });

  it('strength sets summarised per exercise: "Bench press: 4 x 8 @ 60 kg, 4 x 6 @ 70 kg"', async () => {
    const { summarizeSets, formatSetGroup, setTotals } = await load('@/components/workouts/format');
    const groups = summarizeSets(GARMIN_STRENGTH_DETAILS.sets);
    expect(groups.map((g: any) => formatSetGroup(g))).toEqual(['Bench press: 4 x 8 @ 60 kg, 4 x 6 @ 70 kg', 'Squat: 3 x 10']);
    expect(groups[0]).toMatchObject({ exercise: 'Bench press', guess: true, sets: 8, reps: 8 * 4 + 6 * 4 });
    expect(groups.map((g: any) => formatSetGroup(g, 'imperial'))[0]).toBe('Bench press: 4 x 8 @ 132.3 lb, 4 x 6 @ 154.3 lb');
    expect(setTotals(GARMIN_STRENGTH_DETAILS.sets)).toEqual({ sets: 11, reps: 86, medianRestSec: 100 });
  });

  it('sets without a name form one group at the end; sets without reps are counted', async () => {
    const { summarizeSets, formatSetGroup, setTotals } = await load('@/components/workouts/format');
    const groups = summarizeSets([{ reps: 12, durationSec: 40 }, { exercise: 'Curl', guess: true, reps: 10, weightKg: 12.5 }, { reps: 12, durationSec: 40 }, { durationSec: 30 }]);
    expect(groups.map((g: any) => formatSetGroup(g))).toEqual(['Curl: 1 x 10 @ 12.5 kg', 'Sets (exercise not identified by the watch): 2 x 12, 1 set']);
    expect(summarizeSets(undefined)).toEqual([]);
    expect(setTotals(undefined)).toEqual({ sets: 0, reps: 0, medianRestSec: null });
    expect(setTotals([{ restSec: 60 }, { restSec: 90 }]).medianRestSec).toBe(75);
  });

  it("Garmin's words for the training effect", async () => {
    const { trainingEffectLabel } = await load('@/components/workouts/format');
    expect([0.4, 1.5, 2.3, 3.1, 4.2, 5].map(trainingEffectLabel)).toEqual(['No effect', 'Minor', 'Maintaining', 'Improving', 'Highly improving', 'Overreaching']);
  });
});

describe('components/workouts/groups.ts: This week, Last week, then months', () => {
  it('weeks start on Monday', async () => {
    const { weekStart, addDaysIso } = await load('@/components/workouts/groups');
    expect(weekStart('2026-11-10')).toBe('2026-11-09'); // Tuesday
    expect(weekStart('2026-11-09')).toBe('2026-11-09'); // Monday
    expect(weekStart('2026-11-15')).toBe('2026-11-09'); // Sunday
    expect(weekStart('2026-11-08')).toBe('2026-11-02');
    expect(weekStart('2026-01-01')).toBe('2025-12-29'); // across the year
    expect(weekStart('nonsense')).toBe('nonsense');
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('puts a day into its section', async () => {
    const { sectionOf } = await load('@/components/workouts/groups');
    const at = (d: string) => sectionOf(d, TODAY);
    expect(at('2026-11-10')).toEqual({ key: 'this-week', title: 'This week' });
    expect(at('2026-11-09').title).toBe('This week');
    expect(at('2026-11-12').title).toBe('This week'); // a day ahead still counts as this week
    expect(at('2026-11-08').title).toBe('Last week');
    expect(at('2026-11-02').title).toBe('Last week');
    expect(at('2026-11-01')).toEqual({ key: '2026-11', title: 'November 2026' });
    expect(at('2026-10-29')).toEqual({ key: '2026-10', title: 'October 2026' });
    expect(at('2025-12-31')).toEqual({ key: '2025-12', title: 'December 2025' });
    expect(at('garbage')).toEqual({ key: 'unknown', title: 'Undated' });
  });

  it('groups newest-first rows into sections in order, merging a section that comes back', async () => {
    const { groupWorkouts, flattenSections } = await load('@/components/workouts/groups');
    const list = ['2026-11-10', '2026-11-09', '2026-11-08', '2026-11-05', '2026-11-01', '2026-10-29', '2026-11-09'].map((d, i) => ({ id: `r${i}`, entry_date: d }));
    const sections = groupWorkouts(list, TODAY);
    expect(sections.map((s: any) => [s.title, s.rows.map((r: any) => r.id)])).toEqual([
      ['This week', ['r0', 'r1', 'r6']],
      ['Last week', ['r2', 'r3']],
      ['November 2026', ['r4']],
      ['October 2026', ['r5']],
    ]);
    const items = flattenSections(sections);
    expect(items.map((i: any) => (i.type === 'header' ? `# ${i.title} (${i.count})` : i.row.id))).toEqual([
      '# This week (3)', 'r0', 'r1', 'r6', '# Last week (2)', 'r2', 'r3', '# November 2026 (1)', 'r4', '# October 2026 (1)', 'r5',
    ]);
    expect(new Set(items.map((i: any) => i.key)).size).toBe(items.length);
    expect(groupWorkouts([], TODAY)).toEqual([]);
  });

  it('the fixtures fall into three sections', async () => {
    const { groupWorkouts } = await load('@/components/workouts/groups');
    const sorted = [...rows('exercise_entries')].sort((a, b) => String(b.entry_date).localeCompare(String(a.entry_date)));
    expect(groupWorkouts(sorted, TODAY).map((s: any) => s.title)).toEqual(['This week', 'Last week', 'October 2026']);
  });
});

describe('components/workouts/summary.ts: what the detail screen says', () => {
  it('a Garmin strength session with details: every row that has a value', async () => {
    const { summarySections } = await load('@/components/workouts/summary');
    const sections = summarySections(entryOf(IDS.workout.garminStrength), 'metric');
    expect(sections.map((s: any) => s.title)).toEqual(['Summary', 'Heart rate', 'Training effect']);
    const text = (key: string) => sections.flatMap((s: any) => s.rows).find((r: any) => r.key === key);
    expect(text('date').value).toBe('Sunday, 8 November 2026');
    expect(text('duration').value).toBe('50 min');
    expect(text('calories')).toMatchObject({ value: '245 kcal', hint: '190 kcal active' });
    expect(text('source').value).toBe('Garmin');
    expect(text('avg-hr').value).toBe('118 bpm');
    expect(text('max-hr').value).toBe('162 bpm');
    expect(text('min-hr').value).toBe('78 bpm');
    expect(text('aerobic')).toMatchObject({ value: '2.3', hint: 'Maintaining' });
    expect(text('anaerobic')).toMatchObject({ value: '0.6', hint: 'No effect' });
    // a strength session has no distance, pace or climb: no such rows
    for (const key of ['distance', 'pace', 'speed', 'elevation']) expect(text(key), key).toBeUndefined();
    // and the "counts toward energy" note belongs to manual entries only
    expect(JSON.stringify(sections)).not.toContain('energy budget');
  });

  it('a Garmin run: distance, pace and climb, in both unit systems', async () => {
    const { summarySections } = await load('@/components/workouts/summary');
    const metric = summarySections(entryOf(IDS.workout.garminRun), 'metric').flatMap((s: any) => s.rows);
    expect(metric.find((r: any) => r.key === 'distance').value).toBe('5.01 km');
    expect(metric.find((r: any) => r.key === 'pace').value).toBe('6:00 /km');
    expect(metric.find((r: any) => r.key === 'elevation').value).toBe('38 m');
    const imperial = summarySections(entryOf(IDS.workout.garminRun), 'imperial').flatMap((s: any) => s.rows);
    expect(imperial.find((r: any) => r.key === 'distance').value).toBe('3.11 mi');
    expect(imperial.find((r: any) => r.key === 'pace').value).toBe('9:39 /mi');
    expect(imperial.find((r: any) => r.key === 'elevation').value).toBe('125 ft');
  });

  it('a manual workout without details: only what exists, plus the energy note', async () => {
    const { summarySections } = await load('@/components/workouts/summary');
    const sections = summarySections(entryOf(IDS.workout.run), 'metric');
    expect(sections.map((s: any) => s.title)).toEqual(['Summary']);
    const keys = sections[0].rows.map((r: any) => r.key);
    expect(keys).toEqual(['date', 'time', 'duration', 'calories', 'source']);
    expect(sections[0].rows.find((r: any) => r.key === 'calories')).toMatchObject({ value: '320 kcal', hint: 'Counts toward your energy budget' });
    expect(sections[0].rows.find((r: any) => r.key === 'source').value).toBe('Manual');
    const notCounted = summarySections({ ...entryOf(IDS.workout.run), counts_toward_energy: false }, 'metric')[0].rows.find((r: any) => r.key === 'calories');
    expect(notCounted.hint).toBe('Not counted in your energy budget');
  });

  it('a device workout without details (Apple Health) has no heart-rate section', async () => {
    const { summarySections } = await load('@/components/workouts/summary');
    const sections = summarySections(entryOf(IDS.workout.strength), 'metric');
    expect(sections.map((s: any) => s.title)).toEqual(['Summary']);
    expect(sections[0].rows.find((r: any) => r.key === 'source').value).toBe('Apple Health');
    expect(JSON.stringify(sections)).not.toContain('energy budget');
  });

  it('implausible heart rates and missing minutes leave no row', async () => {
    const { summarySections } = await load('@/components/workouts/summary');
    const base = entryOf(IDS.workout.garminStrength);
    const sections = summarySections({ ...base, minutes: null, details: { ...base.details, avgHr: 0, maxHr: 400, minHr: undefined } }, 'metric');
    const keys = sections.flatMap((s: any) => s.rows.map((r: any) => r.key));
    expect(keys).not.toContain('duration');
    expect(keys).not.toContain('avg-hr');
    expect(keys).not.toContain('max-hr');
  });

  it('list rows: icon text, date, duration, source, average heart rate', async () => {
    const { workoutRowText } = await load('@/components/workouts/summary');
    const row = (id: string) => {
      const r = rows('exercise_entries').find((e) => e.id === id) as Record<string, any>;
      return { ...r, avg_hr: r.details?.avgHr ?? null, type_key: r.details?.typeKey ?? null, started_at: localAt(2026, 11, 8, 17, 30) };
    };
    const strength = workoutRowText(row(IDS.workout.garminStrength));
    expect(strength).toMatchObject({ title: 'Strength training', line: 'Sun 8 Nov, 17:30 - 50 min', kcal: '245', source: 'Garmin', hr: 'avg 118 bpm' });
    expect(strength.label).toBe('Strength training, Sun 8 Nov, 17:30, 50 min, 245 kilocalories, Garmin, avg 118 bpm');
    const manual = workoutRowText(row(IDS.workout.run));
    expect(manual.hr).toBeNull();
    expect(manual.source).toBe('Manual');
    expect(manual.label).not.toContain('bpm');
    expect(workoutRowText({ ...row(IDS.workout.run), avg_hr: 0, minutes: null }).line).toBe('Tue 10 Nov, 17:30');
  });

  it('lap lines', async () => {
    const { lapLine } = await load('@/components/workouts/summary');
    expect(lapLine({ index: 1, distanceM: 1000, durationSec: 360, avgHr: 148, paceSecPerKm: 360 }, 'metric')).toBe('1 km - 6:00 /km - 148 bpm');
    expect(lapLine({ index: 2, durationSec: 90 }, 'metric')).toBe('1:30');
    expect(lapLine({ index: 3, distanceM: 400, durationSec: 100, avgHr: 0 }, 'imperial')).toBe('0.25 mi - 1:40');
  });
});

describe('ai/workout-context-text.ts: what the coach is told', () => {
  const ctx = async (id: string, previous: unknown[] = [], maxChars?: number) => {
    const { buildWorkoutContext } = await load('@/ai/workout-context-text');
    const e = entryOf(id);
    return buildWorkoutContext({ workout: { ...e, started_at: localAt(2026, 11, 8, 17, 30), ended_at: localAt(2026, 11, 8, 18, 20) }, previous, ...(maxChars ? { maxChars } : {}) }) as string;
  };
  const PREVIOUS = [
    { entry_date: '2026-11-05', started_at: null, minutes: 48, kcal: 230, avg_hr: 121 },
    { entry_date: '2026-11-02', started_at: null, minutes: 52, kcal: 260, avg_hr: null },
    { entry_date: '2026-10-29', started_at: null, minutes: 45, kcal: 210, avg_hr: 115 },
    { entry_date: '2026-10-20', started_at: null, minutes: 40, kcal: 200, avg_hr: 110 },
  ];

  it('describes a Garmin strength session with everything known', async () => {
    const text = await ctx(IDS.workout.garminStrength, PREVIOUS);
    expect(text).toBe(
      [
        'Workout: Strength training (strength)',
        'Date: Sun 8 Nov 2026, 17:30\u201318:20 local time (evening)',
        'Duration: 50 min',
        'Calories: 245 kcal (190 active)',
        'Source: Garmin',
        'Heart rate: average 118 bpm, max 162 bpm, lowest 78 bpm',
        'Time in heart-rate zones: Z1 7 min, Z2 21 min, Z3 15 min, Z4 6 min, Z5 1 min (Z1 warm-up, Z2 easy, Z3 aerobic, Z4 threshold, Z5 maximum)',
        'Training effect (Garmin, 0-5): aerobic 2.3 (Maintaining), anaerobic 0.6 (No effect)',
        'Sets: 11 sets, 86 reps, median rest 100 s',
        '  Bench press: 4 x 8 @ 60 kg, 4 x 6 @ 70 kg',
        '  Squat: 3 x 10',
        "  (Exercise names are the watch's guess; a weight is only present when the user typed it in.)",
        'Previous 3 workouts of this type (newest first, for comparison):',
        '  Thu 5 Nov: 48 min, avg 121 bpm, 230 kcal',
        '  Mon 2 Nov: 52 min, 260 kcal',
        '  Thu 29 Oct: 45 min, avg 115 bpm, 210 kcal',
        'Not available: nothing important is missing.',
      ].join('\n'),
    );
  });

  it('keeps the privacy promises: no Garmin title, no e-mail, no notes, no ids', async () => {
    const text = await ctx(IDS.workout.garminStrength, PREVIOUS);
    expect(text).not.toMatch(/\S+@\S+\.\S+|garmin:activity|12345678901|token|bearer/i);
    // the stored Garmin title is replaced by the activity type
    const { buildWorkoutContext } = await load('@/ai/workout-context-text');
    const e = entryOf(IDS.workout.garminStrength);
    const named = buildWorkoutContext({ workout: { ...e, name: 'Sarajevo Strength Training' }, previous: [] }) as string;
    expect(named).not.toContain('Sarajevo');
    expect(named.split('\n')[0]).toBe('Workout: Strength training (strength)');
  });

  it('a manual workout keeps its name and says what is missing', async () => {
    const text = await ctx(IDS.workout.run);
    expect(text).toContain('Workout: Running, treadmill, general (running)');
    expect(text).toContain('Source: entered by hand');
    expect(text).toContain('Calories: 320 kcal');
    expect(text).not.toContain('Heart rate:');
    expect(text).toContain('No earlier workouts of this type in the diary to compare with.');
    const last = text.split('\n').pop() as string;
    expect(last).toBe('Not available: No heart-rate data recorded. No time-in-zone data. No distance recorded.');
  });

  it('an Apple Health workout is not a Garmin one: no training effect line, no Garmin notes', async () => {
    const text = await ctx(IDS.workout.strength);
    expect(text).toContain('Workout: Traditional Strength Training (strength)');
    expect(text).toContain('Source: Apple Health');
    expect((text.split('\n').pop() as string)).toBe('Not available: No heart-rate data recorded. No time-in-zone data.');
  });

  it('a Garmin workout whose details were never read says so', async () => {
    const text = await ctx(IDS.workout.garminOld);
    // a Garmin title is never sent: the activity type (here guessed from the name, no details) stands in for it
    expect(text).toContain('Workout: Cycling (cycling)');
    expect(text).not.toContain('Evening ride');
    expect((text.split('\n').pop() as string)).toContain('Garmin details have not been read for this workout');
    expect((text.split('\n').pop() as string)).toContain('No heart-rate data recorded');
  });

  it('a run with the list summary: distance, pace, climb, no sets', async () => {
    const text = await ctx(IDS.workout.garminRun, PREVIOUS.slice(0, 1));
    expect(text).toContain('Distance: 5.01 km; Average pace: 6:00 /km; Elevation gain: 38 m');
    expect(text).toContain('Heart rate: average 150 bpm, max 175 bpm');
    expect(text).toContain('Training effect (Garmin, 0-5): aerobic 3.1 (Improving), anaerobic 1.2 (Minor)');
    expect(text).not.toContain('Sets:');
    expect(text).toContain('Previous 1 workouts of this type');
  });

  it('stays within the limit by dropping laps first, and always keeps the last line', async () => {
    const { buildWorkoutContext } = await load('@/ai/workout-context-text');
    const e = entryOf(IDS.workout.garminRun);
    const laps = Array.from({ length: 20 }, (_, i) => ({ index: i + 1, distanceM: 1000, durationSec: 360, avgHr: 150, paceSecPerKm: 360 }));
    const withLaps = buildWorkoutContext({ workout: { ...e, details: { ...e.details, laps } }, previous: PREVIOUS }) as string;
    expect(withLaps).toContain('Laps: 1) 1 km 6:00 /km 150 bpm');
    expect(withLaps).toContain('...and 10 more');
    const tight = buildWorkoutContext({ workout: { ...e, details: { ...e.details, laps } }, previous: PREVIOUS, maxChars: 700 }) as string;
    expect(tight.length).toBeLessThanOrEqual(700);
    expect(tight).not.toContain('Laps:');
    expect(tight.split('\n').pop()).toBe('Not available: nothing important is missing.');
    const tiny = buildWorkoutContext({ workout: { ...e, details: { ...e.details, laps } }, previous: PREVIOUS, maxChars: 260 }) as string;
    expect(tiny.length).toBeLessThanOrEqual(260);
    expect(tiny.split('\n').pop()).toBe('Not available: nothing important is missing.');
  });

  it('a huge strength session is cut to fit in about 2,500 characters', async () => {
    const { buildWorkoutContext } = await load('@/ai/workout-context-text');
    const e = entryOf(IDS.workout.garminStrength);
    const names = Array.from({ length: 40 }, (_, i) => `Exercise number ${i}`);
    const sets = names.flatMap((exercise) => Array.from({ length: 3 }, (_, k) => ({ exercise, guess: true, reps: 8 + k, weightKg: 20 + k * 5, durationSec: 30, restSec: 60 })));
    const text = buildWorkoutContext({ workout: { ...e, details: { ...e.details, sets: sets.slice(0, 120) } }, previous: PREVIOUS }) as string;
    expect(text.length).toBeLessThanOrEqual(2500);
    expect(text).toContain('more exercises');
    expect(text.split('\n').pop()).toBe('Not available: nothing important is missing.');
  });

  it('the GARMIN_RUN_SUMMARY fixture is itself valid v1 details', () => {
    expect(parseWorkoutDetails(GARMIN_RUN_SUMMARY)).toMatchObject({ level: 'summary', avgHr: 150 });
    expect(parseWorkoutDetails(GARMIN_STRENGTH_DETAILS)?.sets).toHaveLength(11);
  });
});
