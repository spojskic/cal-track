// Garmin is read straight from Garmin AND can come back through Apple Health / Health Connect. Whatever both write must show
// up once in the diary and must not double count for the coach. Pure logic: no browser, no network.
import { describe, expect, it } from 'vitest';

/** App modules are loaded through the `@/` alias and are untyped here on purpose (this package knows nothing about React Native). */
const load = (specifier: string): Promise<any> => import(/* @vite-ignore */ specifier);

type Rec = Record<string, unknown>;
interface DeviceRow {
  key: string;
  name: string;
  detail?: string;
  burnedKcal?: number;
}
interface SummaryBits {
  sleep?: { date: string; hours: number; quality?: number }[];
  activity?: { workouts?: { type: string }[] }[];
}

const coach = await load('@/ai/coach-summary');
const deviceRows = await load('@/components/diary/device-rows');
const buildCoachSummary = coach.buildCoachSummary as (input: Rec) => SummaryBits;
const withoutDuplicateWorkouts = coach.withoutDuplicateWorkouts as (rows: Rec[]) => { name: string }[];
const buildDeviceRows = deviceRows.buildDeviceRows as (exercise: Rec[], energy: Rec[], bio: Rec[]) => { rows: DeviceRow[]; sources: string[] };
const duplicateWorkoutIds = deviceRows.duplicateWorkoutIds as (exercise: Rec[]) => Set<string>;

const workout = (over: Rec): Rec => ({
  id: 'x',
  entry_date: '2026-11-09',
  activity_code: null,
  name: 'Run',
  minutes: 30,
  kcal: 300,
  source: 'garmin',
  external_id: 'e',
  started_at: '2026-11-09T06:30:00.000Z',
  ended_at: '2026-11-09T07:00:00.000Z',
  counts_toward_energy: false,
  ...over,
});
const energy = (source: string, active: number | null, steps: number | null = null): Rec => ({
  local_date: '2026-11-09',
  source,
  active_kcal: active,
  resting_kcal: 1800,
  steps,
});
const bio = (over: Rec): Rec => ({
  id: 'b',
  entry_date: '2026-11-09',
  type: 'sleep',
  value: 7.5,
  unit: 'hr',
  source: 'garmin',
  recorded_at: null,
  meta: null,
  ...over,
});

describe('diary device group with Garmin and Apple Health both connected', () => {
  it('lists the daily activity once, from the source the energy numbers use', () => {
    const rows = [energy('apple_health', 500, 8000), energy('garmin', 612, 9876)];
    const { rows: out, sources } = buildDeviceRows([], rows, []);
    expect(out).toEqual([{ key: 'energy-garmin', name: 'Daily Activity', detail: '9,876 steps', burnedKcal: 612 }]);
    expect(sources).toEqual(['garmin']);
  });

  it('falls back to the other source when Garmin has no active energy for the day', () => {
    const { rows } = buildDeviceRows([], [energy('garmin', null), energy('apple_health', 500, 8000)], []);
    expect(rows.map((r) => r.key)).toEqual(['energy-apple_health']);
  });

  it('shows one workout recorded by both sources, Garmin\'s copy', () => {
    const garmin = workout({ id: 'g', source: 'garmin', kcal: 412 });
    const apple = workout({ id: 'a', source: 'apple_health', kcal: 380, started_at: '2026-11-09T06:30:20.000Z', ended_at: '2026-11-09T07:00:05.000Z' });
    expect([...duplicateWorkoutIds([garmin, apple])]).toEqual(['a']);
    const { rows } = buildDeviceRows([apple, garmin], [], []);
    expect(rows.map((r) => [r.key, r.burnedKcal])).toEqual([['exercise-g', 412]]);
  });

  it('keeps workouts that are really different, untimed ones, and manual ones out of the device list', () => {
    const run = workout({ id: 'g' });
    const evening = workout({ id: 'a', source: 'apple_health', started_at: '2026-11-09T18:00:00.000Z', ended_at: '2026-11-09T18:40:00.000Z' });
    const untimed = workout({ id: 'u', source: 'apple_health', started_at: null, ended_at: null });
    const manual = workout({ id: 'm', source: 'manual' });
    expect(duplicateWorkoutIds([run, evening, untimed, manual]).size).toBe(0);
    expect(buildDeviceRows([run, evening, untimed, manual], [], []).rows.map((r) => r.key)).toEqual(['exercise-g', 'exercise-a', 'exercise-u']);
  });

  it('a workout that only touches another one at its edge is not a duplicate', () => {
    const a = workout({ id: 'g', started_at: '2026-11-09T06:00:00.000Z', ended_at: '2026-11-09T07:00:00.000Z' });
    const b = workout({ id: 'a', source: 'apple_health', started_at: '2026-11-09T06:55:00.000Z', ended_at: '2026-11-09T07:30:00.000Z' });
    expect(duplicateWorkoutIds([a, b]).size).toBe(0);
  });

  it('lists a measurement once per kind, from the best-ranked source', () => {
    const { rows } = buildDeviceRows(
      [],
      [],
      [bio({ id: '1', source: 'apple_health', value: 7.4 }), bio({ id: '2', source: 'garmin', value: 7.5 }), bio({ id: '3', type: 'hrv', unit: 'ms', source: 'apple_health', value: 55 })],
    );
    expect(rows.map((r) => [r.key, r.detail])).toEqual([
      ['bio-2', '7.5 hr'],
      ['bio-3', '55 ms'],
    ]);
  });

  it('with only one source nothing changes', () => {
    const { rows, sources } = buildDeviceRows([workout({ id: 'g' })], [energy('garmin', 612, 9876)], [bio({ id: '1' })]);
    expect(rows.map((r) => r.key)).toEqual(['energy-garmin', 'exercise-g', 'bio-1']);
    expect(sources).toEqual(['garmin']);
  });
});

describe('coach summary with Garmin and Apple Health both connected', () => {
  const base = { today: '2026-11-10' };

  it('does not add a night that two sources both describe', () => {
    const summary = buildCoachSummary({
      ...base,
      biometrics: [
        { date: '2026-11-09', type: 'sleep', value: 7.5, unit: 'hr', source: 'garmin' },
        { date: '2026-11-09', type: 'sleep', value: 7.4, unit: 'hr', source: 'apple_health' },
        { date: '2026-11-09', type: 'sleep_score', value: 81, source: 'garmin' },
      ],
    });
    expect(summary.sleep).toEqual([{ date: '2026-11-09', hours: 7.5, quality: 81 }]);
  });

  it('still adds the naps and segments of ONE source', () => {
    const summary = buildCoachSummary({
      ...base,
      biometrics: [
        { date: '2026-11-09', type: 'sleep', value: 6, unit: 'hr', source: 'apple_health' },
        { date: '2026-11-09', type: 'sleep', value: 1.5, unit: 'hr', source: 'apple_health' },
      ],
    });
    expect(summary.sleep).toEqual([{ date: '2026-11-09', hours: 7.5 }]);
  });

  it('rows without a source keep working as before (they are one source)', () => {
    const summary = buildCoachSummary({ ...base, biometrics: [{ date: '2026-11-09', type: 'sleep', value: 7, unit: 'hr' }] });
    expect(summary.sleep).toEqual([{ date: '2026-11-09', hours: 7 }]);
  });

  it('lists a workout seen by both sources once', () => {
    const rows: Rec[] = [
      { date: '2026-11-09', name: 'Run', minutes: 30, kcal: 380, source: 'apple_health', startedAt: '2026-11-09T06:30:20.000Z', endedAt: '2026-11-09T07:00:05.000Z' },
      { date: '2026-11-09', name: 'Running', minutes: 30, kcal: 412, source: 'garmin', startedAt: '2026-11-09T06:30:00.000Z', endedAt: '2026-11-09T07:00:00.000Z' },
      { date: '2026-11-09', name: 'Yoga', minutes: 40, kcal: 100, source: 'manual' },
    ];
    expect(withoutDuplicateWorkouts(rows).map((r) => r.name)).toEqual(['Running', 'Yoga']);
    const summary = buildCoachSummary({ ...base, exercise: rows });
    expect(summary.activity?.[0]?.workouts?.map((w) => w.type)).toEqual(['Running', 'Yoga']);
  });
});
