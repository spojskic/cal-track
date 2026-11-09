// Sleep night assignment and summary. Pure.
//
// A "night" is keyed by the local date it ENDS on. Segments are assigned by their midpoint: the night ending on D
// covers [D-1 18:00, D 18:00) local time, so a 23:00-07:00 sleep lands on the morning's date, and an afternoon nap of
// day D is counted with the night that ended that morning (D) rather than with the one starting that evening.
//
// Several sources (Watch + Garmin + phone) often describe the same night. To avoid double counting, only the source
// with the most asleep time in that night is used; inside that source overlapping segments are merged.
import { toLocalDate } from './dates';
import type { BiometricPoint, DateRange, LocalDate, MetaValue } from './types';

export type SleepStage = 'in_bed' | 'awake' | 'asleep' | 'core' | 'deep' | 'rem';

export interface SleepSegment {
  startMs: number;
  endMs: number;
  stage: SleepStage;
  /** Bundle id / package name of the app that wrote it. */
  source: string;
}

export interface NightSummary {
  date: LocalDate;
  /** Total time asleep, minutes (union of core/deep/rem/unspecified asleep time). */
  asleepMinutes: number;
  coreMinutes: number;
  deepMinutes: number;
  remMinutes: number;
  /** Asleep but not classified into a stage. */
  unspecifiedMinutes: number;
  awakeMinutes: number;
  /** True when the source reported core/deep/rem stages. */
  staged: boolean;
  endedAtMs: number;
  source: string;
}

/** Nights with less asleep time than this are stray sensor blips, not sleep. */
export const MIN_ASLEEP_MINUTES = 15;

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const ASLEEP_STAGES: ReadonlySet<SleepStage> = new Set(['asleep', 'core', 'deep', 'rem']);

/** Local date of the night a segment belongs to (midpoint shifted by 6 h so the cut is at 18:00). */
export function nightDateOf(startMs: number, endMs: number): LocalDate {
  const mid = startMs + (endMs - startMs) / 2;
  return toLocalDate(new Date(mid + 6 * HOUR_MS));
}

/** Total length in ms of the union of [start, end) intervals. */
export function unionMs(intervals: readonly (readonly [number, number])[]): number {
  const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = 0;
  let curEnd = 0;
  let open = false;
  for (const [s, e] of sorted) {
    if (!open) {
      curStart = s;
      curEnd = e;
      open = true;
    } else if (s <= curEnd) {
      curEnd = Math.max(curEnd, e);
    } else {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    }
  }
  if (open) total += curEnd - curStart;
  return total;
}

const toMinutes = (ms: number) => ms / MINUTE_MS;

function summarizeSource(date: LocalDate, source: string, segments: readonly SleepSegment[]): NightSummary {
  const byStage = (...stages: SleepStage[]) =>
    segments.filter((s) => stages.includes(s.stage)).map((s) => [s.startMs, s.endMs] as const);
  const asleep = unionMs(byStage('asleep', 'core', 'deep', 'rem'));
  const core = unionMs(byStage('core'));
  const deep = unionMs(byStage('deep'));
  const rem = unionMs(byStage('rem'));
  const unspecified = unionMs(byStage('asleep'));
  const awake = unionMs(byStage('awake'));
  const asleepSegments = segments.filter((s) => ASLEEP_STAGES.has(s.stage));
  return {
    date,
    asleepMinutes: toMinutes(asleep),
    coreMinutes: toMinutes(core),
    deepMinutes: toMinutes(deep),
    remMinutes: toMinutes(rem),
    unspecifiedMinutes: toMinutes(unspecified),
    awakeMinutes: toMinutes(awake),
    staged: core + deep + rem > 0,
    endedAtMs: asleepSegments.reduce((max, s) => Math.max(max, s.endMs), 0),
    source,
  };
}

/**
 * One summary per night that has at least MIN_ASLEEP_MINUTES of sleep, oldest first. With `range`, nights outside it
 * are dropped (the caller usually queries a slightly larger window).
 */
export function summarizeNights(segments: readonly SleepSegment[], range?: DateRange): NightSummary[] {
  const nights = new Map<LocalDate, Map<string, SleepSegment[]>>();
  for (const seg of segments) {
    if (!(seg.endMs > seg.startMs) || seg.stage === 'in_bed') continue;
    const date = nightDateOf(seg.startMs, seg.endMs);
    if (range && (date < range.from || date > range.to)) continue;
    const bySource = nights.get(date) ?? new Map<string, SleepSegment[]>();
    const list = bySource.get(seg.source) ?? [];
    list.push(seg);
    bySource.set(seg.source, list);
    nights.set(date, bySource);
  }

  const result: NightSummary[] = [];
  for (const [date, bySource] of nights) {
    let best: NightSummary | undefined;
    for (const [source, list] of bySource) {
      const summary = summarizeSource(date, source, list);
      if (!best || summary.asleepMinutes > best.asleepMinutes) best = summary;
    }
    if (best && best.asleepMinutes >= MIN_ASLEEP_MINUTES) result.push(best);
  }
  return result.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Biometric row for one night: hours asleep, stage minutes in `meta` when the source reported them. */
export function nightToBiometricPoint(night: NightSummary): BiometricPoint {
  const meta: Record<string, MetaValue> = { source: night.source };
  const minutes = (value: number) => Math.round(value);
  if (night.staged) {
    meta.core = minutes(night.coreMinutes);
    meta.deep = minutes(night.deepMinutes);
    meta.rem = minutes(night.remMinutes);
  }
  if (night.staged || night.awakeMinutes > 0) meta.awake = minutes(night.awakeMinutes);
  if (night.staged && night.unspecifiedMinutes > 0) meta.unspecified = minutes(night.unspecifiedMinutes);
  meta.staged = night.staged;
  return {
    type: 'sleep',
    date: night.date,
    value: Math.round((night.asleepMinutes / 60) * 100) / 100,
    unit: 'hr',
    externalId: `sleep:${night.date}`,
    recordedAt: new Date(night.endedAtMs).toISOString(),
    meta,
  };
}
