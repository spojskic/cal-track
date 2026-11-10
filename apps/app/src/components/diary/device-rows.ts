// The "Garmin and Apple Health activity" group of a diary day, as plain data (no React) so it is unit tested in tools/ui-smoke.
//
// Garmin is read straight from Garmin AND can reach the app again through Apple Health / Health Connect. Both then write a
// daily-energy row, the same workouts and the same nights. The group lists each thing ONCE, from the best-ranked source
// (Garmin first, the same order as data/energy.ts uses for the energy numbers).
import { formatNumber } from '@/components/charts/format';
import type { BiometricEntry, DailyEnergyRow, ExerciseEntry } from '@/data/activity';

import { prettifyType } from './activity-rows';

export interface DeviceRow {
  key: string;
  name: string;
  /** Secondary text ("45 min", "8,543 steps", "62 bpm"). */
  detail?: string;
  /** Burned energy (positive number); shown as a negative kcal value. */
  burnedKcal?: number;
}

/** Same order as SOURCE_PRIORITY in data/energy.ts: the first source wins when several describe the same thing. */
const SOURCE_RANK = ['garmin', 'apple_health', 'health_connect'];
const rank = (source: string): number => {
  const i = SOURCE_RANK.indexOf(source);
  return i === -1 ? SOURCE_RANK.length : i;
};

const ms = (iso: string | null): number | undefined => {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
};

/** Device workouts that a better-ranked source also recorded (same time, more than half of the shorter one overlaps). */
export function duplicateWorkoutIds(exercise: readonly ExerciseEntry[]): Set<string> {
  const timed = exercise.flatMap((e) => {
    const start = ms(e.started_at);
    const end = ms(e.ended_at);
    return e.source !== 'manual' && start !== undefined && end !== undefined && end > start ? [{ e, start, end }] : [];
  });
  const duplicates = new Set<string>();
  for (const a of timed) {
    for (const b of timed) {
      if (a === b || rank(b.e.source) >= rank(a.e.source)) continue;
      const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
      if (overlap > 0.5 * Math.min(a.end - a.start, b.end - b.start)) duplicates.add(a.e.id);
    }
  }
  return duplicates;
}

/** Device-sourced exercise, daily activity and biometrics shown in the "Garmin and Misc" style group. */
export function buildDeviceRows(
  exercise: readonly ExerciseEntry[],
  energyRows: readonly DailyEnergyRow[],
  biometrics: readonly BiometricEntry[],
): { rows: DeviceRow[]; sources: string[] } {
  const rows: DeviceRow[] = [];
  const sources = new Set<string>();

  // One daily-activity line: the best-ranked source that has active energy (the one the energy numbers use).
  const energy = [...energyRows]
    .filter((e) => e.source !== 'manual' && e.active_kcal !== null)
    .sort((a, b) => rank(a.source) - rank(b.source))[0];
  if (energy) {
    sources.add(energy.source);
    if (energy.active_kcal !== null && energy.active_kcal > 0) {
      rows.push({
        key: `energy-${energy.source}`,
        name: 'Daily Activity',
        detail: energy.steps ? `${formatNumber(energy.steps)} steps` : undefined,
        burnedKcal: energy.active_kcal,
      });
    }
  }

  const duplicates = duplicateWorkoutIds(exercise);
  for (const e of exercise) {
    if (e.source === 'manual' || duplicates.has(e.id)) continue;
    sources.add(e.source);
    rows.push({
      key: `exercise-${e.id}`,
      name: e.name,
      detail: e.minutes ? `${formatNumber(e.minutes, 0, true)} min` : undefined,
      burnedKcal: e.kcal,
    });
  }

  // Per kind of measurement only the best-ranked source's readings (two sources of the same night would list it twice).
  const bestSourceOfType = new Map<string, string>();
  for (const b of biometrics) {
    if (b.source === 'manual') continue;
    const best = bestSourceOfType.get(b.type);
    if (best === undefined || rank(b.source) < rank(best)) bestSourceOfType.set(b.type, b.source);
  }
  for (const b of biometrics) {
    if (b.source === 'manual' || bestSourceOfType.get(b.type) !== b.source) continue;
    sources.add(b.source);
    rows.push({
      key: `bio-${b.id}`,
      name: prettifyType(b.type),
      detail: `${formatNumber(b.value, 1, true)}${b.unit ? ` ${b.unit}` : ''}`,
    });
  }
  return { rows, sources: [...sources] };
}
