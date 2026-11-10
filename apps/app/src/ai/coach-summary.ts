/**
 * Pure builder for the data summary the AI coach is grounded on.
 *
 * No React / React Native / Supabase imports on purpose: it only receives plain rows and returns the
 * `CoachSummary` that `@cal/ai` wraps in a size-capped `<user_data>` block (the model is told that block is
 * DATA, never instructions). Fetching lives in `data/coach.ts` and wiring in `use-coach-summary.ts`.
 *
 * Decisions:
 *  - `intake` holds COMPLETED days only (the 14 days before today, logged days only). The context builder
 *    averages every row it gets, so a half-eaten today would skew the average; today is passed as a separate
 *    one-line note instead. Unlogged days are left out, because a 0 kcal row would read as "ate nothing".
 *  - Everything is rounded for the model (kcal and grams to integers, fibre / sleep / weight to 0.1, trend to
 *    0.01 kg per week); the model should talk about trends, not false precision.
 *  - Free-text diary notes are deliberately NOT sent (less personal data leaves the device).
 */

import type {
  CoachActivityDay,
  CoachGoals,
  CoachIntakeDay,
  CoachSleepNight,
  CoachSummary,
  CoachTargets,
  CoachWeightPoint,
} from '@cal/ai';

export const INTAKE_DAYS = 14;
export const ACTIVITY_DAYS = 14;
export const SLEEP_DAYS = 14;
export const WEIGHT_DAYS = 30;
/** buildCoachContext keeps only the last 14 weight rows, so the 30-day series is thinned to this many. */
export const WEIGHT_POINTS_MAX = 14;

// ---------------------------------------------------------------------------------------------------------------
// Input rows (plain data, already normalised to the units noted)
// ---------------------------------------------------------------------------------------------------------------

export interface SummaryDailyTotal {
  /** YYYY-MM-DD, the user's local date */
  date: string;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG: number;
  entryCount: number;
}

export interface SummaryWeightRow {
  date: string;
  kg: number;
}

export interface SummaryExerciseRow {
  date: string;
  name: string;
  minutes: number | null;
  kcal: number;
  /** 'garmin' | 'apple_health' | 'health_connect' | 'manual'. With the times it lets one workout seen by two devices count once. */
  source?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
}

export interface SummaryDeviceEnergyRow {
  date: string;
  /** 'garmin' | 'apple_health' | 'health_connect' | 'manual' */
  source: string;
  activeKcal: number | null;
  steps: number | null;
}

export interface SummaryBiometricRow {
  date: string;
  type: string;
  value: number;
  unit?: string | null;
  /** 'garmin' | 'apple_health' | 'health_connect' | 'manual'. Two sources of the same night must not add up. */
  source?: string | null;
}

export interface SummaryTargetsInput {
  kcal?: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
  fiberG?: number;
  sodiumMg?: number;
}

export interface SummaryProfileInput {
  sex?: string | null;
  ageYears?: number | null;
  heightCm?: number | null;
  activityLevel?: string | null;
}

/** Structural copy of `MacroMode` from @cal/core (kept structural so this file has no imports). */
export interface SummaryMacroMode {
  mode: string;
  [key: string]: unknown;
}

export interface BuildCoachSummaryInput {
  /** Today's local date, YYYY-MM-DD. */
  today: string;
  targets?: SummaryTargetsInput | null;
  profile?: SummaryProfileInput | null;
  /** Signed kg per week from the active weight goal (negative = lose). */
  rateKgPerWeek?: number | null;
  targetWeightKg?: number | null;
  macroMode?: SummaryMacroMode | null;
  /** 'static' | 'device_adjusted' | 'device_total' */
  energyMode?: string | null;
  netCarbs?: boolean | null;
  /** Most recent logged weight, any age. */
  latestWeightKg?: number | null;
  /** Each series is null/undefined when it could not be loaded; the section is then simply left out. */
  dailyTotals?: readonly SummaryDailyTotal[] | null;
  weight?: readonly SummaryWeightRow[] | null;
  exercise?: readonly SummaryExerciseRow[] | null;
  deviceEnergy?: readonly SummaryDeviceEnergyRow[] | null;
  biometrics?: readonly SummaryBiometricRow[] | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseIso(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

/** Adds whole days to a YYYY-MM-DD date (calendar math in UTC, so DST can never shift a day). */
export function shiftDate(iso: string, days: number): string {
  return new Date(parseIso(iso) + days * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((parseIso(toIso) - parseIso(fromIso)) / 86_400_000);
}

export function round(n: number, decimals = 0): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const positive = (n: unknown): n is number => finite(n) && n > 0;

const byDate = <T extends { date: string }>(a: T, b: T): number => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

// ---------------------------------------------------------------------------------------------------------------
// Weight
// ---------------------------------------------------------------------------------------------------------------

/**
 * Least-squares slope of the weight points in kg per week. Needs at least two points that span a week or more,
 * otherwise the extrapolation to a week would be noise (returns undefined).
 */
export function weightTrendKgPerWeek(points: readonly SummaryWeightRow[]): number | undefined {
  const pts = points.filter((p) => ISO_RE.test(p.date) && positive(p.kg)).sort(byDate);
  if (pts.length < 2) return undefined;
  const first = pts[0] as SummaryWeightRow;
  const last = pts[pts.length - 1] as SummaryWeightRow;
  if (daysBetween(first.date, last.date) < 7) return undefined;
  const xs = pts.map((p) => daysBetween(first.date, p.date));
  const ys = pts.map((p) => p.kg);
  const n = pts.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += ((xs[i] as number) - mx) * ((ys[i] as number) - my);
    den += ((xs[i] as number) - mx) ** 2;
  }
  if (den === 0) return undefined;
  return round((num / den) * 7, 2);
}

/** Evenly thins a series to at most `max` items, always keeping the first and the last. */
export function thin<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  if (max < 2) return items.slice(-Math.max(0, max));
  const out: T[] = [];
  const step = (items.length - 1) / (max - 1);
  let lastIndex = -1;
  for (let i = 0; i < max; i++) {
    const idx = i === max - 1 ? items.length - 1 : Math.round(i * step);
    if (idx !== lastIndex) out.push(items[idx] as T);
    lastIndex = idx;
  }
  return out;
}

function buildWeight(input: BuildCoachSummaryInput): CoachSummary['weight'] {
  const from = shiftDate(input.today, -WEIGHT_DAYS);
  const rows = (input.weight ?? [])
    .filter((p) => ISO_RE.test(p.date) && p.date >= from && p.date <= input.today && positive(p.kg))
    .sort(byDate);
  const latest = positive(input.latestWeightKg) ? input.latestWeightKg : rows[rows.length - 1]?.kg;
  const trend = weightTrendKgPerWeek(rows);
  const points: CoachWeightPoint[] = thin(rows, WEIGHT_POINTS_MAX).map((p) => ({ date: p.date, kg: round(p.kg, 1) }));
  if (latest === undefined && trend === undefined && points.length === 0) return undefined;
  return {
    ...(latest !== undefined ? { currentKg: round(latest, 1) } : {}),
    ...(trend !== undefined ? { trendKgPerWeek: trend } : {}),
    ...(points.length ? { points } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------------------------------------------

function toIntakeDay(d: SummaryDailyTotal): CoachIntakeDay {
  return {
    date: d.date,
    kcal: round(d.kcal),
    proteinG: round(d.proteinG),
    carbsG: round(d.carbsG),
    fatG: round(d.fatG),
    fiberG: round(d.fiberG, 1),
  };
}

const isLogged = (d: SummaryDailyTotal): boolean => finite(d.entryCount) && d.entryCount > 0 && positive(d.kcal);

function buildIntake(input: BuildCoachSummaryInput): CoachIntakeDay[] {
  const from = shiftDate(input.today, -INTAKE_DAYS);
  return (input.dailyTotals ?? [])
    .filter((d) => ISO_RE.test(d.date) && d.date >= from && d.date < input.today && isLogged(d))
    .sort(byDate)
    .map(toIntakeDay);
}

function todaySoFar(input: BuildCoachSummaryInput): string | undefined {
  const today = (input.dailyTotals ?? []).find((d) => d.date === input.today);
  if (!today || !isLogged(today)) return undefined;
  const t = toIntakeDay(today);
  return (
    `today_so_far (day not finished, do not treat as a full day): ${t.kcal} kcal; protein ${t.proteinG} g; ` +
    `carbs ${t.carbsG} g; fat ${t.fatG} g; fiber ${t.fiberG} g`
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------------------------------------------

/** Only one device row per day may count (several sources would double count); the order mirrors data/energy.ts. */
const SOURCE_PRIORITY = ['garmin', 'apple_health', 'health_connect', 'manual'];

function sourceRank(source: string): number {
  const i = SOURCE_PRIORITY.indexOf(source);
  return i === -1 ? SOURCE_PRIORITY.length : i;
}

/**
 * Garmin can reach the app twice: read directly, and through Apple Health / Health Connect. The same workout then exists once
 * per source, with (nearly) the same start and end. Only the best-ranked source's copy is kept; a workout without times, a
 * manual one, or one that merely touches another stays.
 */
export function withoutDuplicateWorkouts(rows: readonly SummaryExerciseRow[]): SummaryExerciseRow[] {
  const timed = rows.flatMap((r) => {
    const start = Date.parse(r.startedAt ?? '');
    const end = Date.parse(r.endedAt ?? '');
    return r.source && r.source !== 'manual' && Number.isFinite(start) && Number.isFinite(end) && end > start ? [{ r, start, end }] : [];
  });
  const duplicate = new Set<SummaryExerciseRow>();
  for (const a of timed) {
    for (const b of timed) {
      if (a === b || sourceRank(b.r.source ?? '') >= sourceRank(a.r.source ?? '')) continue;
      const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
      if (overlap > 0.5 * Math.min(a.end - a.start, b.end - b.start)) duplicate.add(a.r);
    }
  }
  return rows.filter((r) => !duplicate.has(r));
}

function buildActivity(input: BuildCoachSummaryInput): CoachActivityDay[] {
  const from = shiftDate(input.today, -(ACTIVITY_DAYS - 1));
  const inRange = (date: string) => ISO_RE.test(date) && date >= from && date <= input.today;

  const device = new Map<string, SummaryDeviceEnergyRow>();
  for (const r of input.deviceEnergy ?? []) {
    if (!inRange(r.date)) continue;
    if (!positive(r.activeKcal) && !positive(r.steps)) continue;
    const current = device.get(r.date);
    if (!current || sourceRank(r.source) < sourceRank(current.source)) device.set(r.date, r);
  }

  const workouts = new Map<string, { type: string; minutes?: number }[]>();
  for (const e of withoutDuplicateWorkouts(input.exercise ?? [])) {
    if (!inRange(e.date)) continue;
    const list = workouts.get(e.date) ?? [];
    list.push({
      type: e.name,
      ...(positive(e.minutes) ? { minutes: round(e.minutes) } : {}),
    });
    workouts.set(e.date, list);
  }

  const dates = [...new Set([...device.keys(), ...workouts.keys()])].sort();
  return dates.map((date): CoachActivityDay => {
    const d = device.get(date);
    const w = workouts.get(date);
    return {
      date,
      ...(d && positive(d.steps) ? { steps: round(d.steps) } : {}),
      ...(d && positive(d.activeKcal) ? { activeKcal: round(d.activeKcal) } : {}),
      ...(w && w.length ? { workouts: w.slice(0, 4) } : {}),
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Sleep
// ---------------------------------------------------------------------------------------------------------------

const SLEEP_DURATION_TYPES = new Set(['sleep', 'sleep_duration', 'sleep_hours', 'sleep_minutes', 'sleep_time']);
const SLEEP_QUALITY_TYPES = new Set(['sleep_quality', 'sleep_score']);

/** Biometric `type` values this module understands as sleep data (also used to filter the query). */
export const SLEEP_BIOMETRIC_TYPES: readonly string[] = [...SLEEP_DURATION_TYPES, ...SLEEP_QUALITY_TYPES];

function sleepHours(row: SummaryBiometricRow): number | undefined {
  const v = row.value;
  if (!positive(v)) return undefined;
  const unit = (row.unit ?? '').trim().toLowerCase();
  let hours: number;
  if (row.type === 'sleep_minutes' || /^(m|min|mins|minute|minutes)$/.test(unit)) hours = v / 60;
  else if (/^(s|sec|secs|second|seconds)$/.test(unit)) hours = v / 3600;
  else if (/^(h|hr|hrs|hour|hours)$/.test(unit)) hours = v;
  else hours = v > 24 ? v / 60 : v; // unit unknown: more than 24 can only be minutes
  return hours > 0 && hours <= 24 ? hours : undefined;
}

function buildSleep(input: BuildCoachSummaryInput): CoachSleepNight[] {
  const from = shiftDate(input.today, -(SLEEP_DAYS - 1));
  // Hours per night and per source: segments / naps of ONE source add up, but two sources describing the same night (Garmin read
  // directly and Garmin shared through Apple Health) must not, so only the best-ranked source's hours are used.
  const hoursBySource = new Map<string, Map<string, number>>();
  const qualityByDate = new Map<string, { value: number; rank: number }>();
  for (const r of input.biometrics ?? []) {
    if (!ISO_RE.test(r.date) || r.date < from || r.date > input.today) continue;
    const rank = sourceRank(r.source ?? '');
    if (SLEEP_DURATION_TYPES.has(r.type)) {
      const h = sleepHours(r);
      if (h === undefined) continue;
      const perSource = hoursBySource.get(r.date) ?? new Map<string, number>();
      perSource.set(r.source ?? '', (perSource.get(r.source ?? '') ?? 0) + h);
      hoursBySource.set(r.date, perSource);
    } else if (SLEEP_QUALITY_TYPES.has(r.type) && finite(r.value) && r.value >= 0) {
      const current = qualityByDate.get(r.date);
      if (!current || rank <= current.rank) qualityByDate.set(r.date, { value: r.value, rank });
    }
  }
  const hoursByDate = new Map<string, number>();
  for (const [date, perSource] of hoursBySource) {
    const best = [...perSource.entries()].sort(([a], [b]) => sourceRank(a) - sourceRank(b))[0];
    if (best) hoursByDate.set(date, best[1]);
  }
  return [...hoursByDate.entries()]
    .filter(([, h]) => h > 0 && h <= 24)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, h]): CoachSleepNight => {
      const q = qualityByDate.get(date)?.value;
      return { date, hours: round(h, 1), ...(q !== undefined ? { quality: round(q) } : {}) };
    });
}

// ---------------------------------------------------------------------------------------------------------------
// Goals + targets + profile
// ---------------------------------------------------------------------------------------------------------------

export function describeMacroMode(mode: SummaryMacroMode | null | undefined): string | undefined {
  if (!mode) return undefined;
  const n = (key: string): number | undefined => (finite(mode[key]) ? (mode[key] as number) : undefined);
  switch (mode.mode) {
    case 'ratios':
      return `macro split ${round(n('proteinPct') ?? 0)}% protein / ${round(n('carbsPct') ?? 0)}% carbs / ${round(n('fatPct') ?? 0)}% fat`;
    case 'fixed':
      return `fixed macros ${round(n('proteinG') ?? 0)} g protein / ${round(n('carbsG') ?? 0)} g carbs / ${round(n('fatG') ?? 0)} g fat`;
    case 'keto':
      return `keto mode: ${round(n('netCarbsG') ?? 0)} g net carbs, ${round(n('proteinGPerKgLean') ?? 0, 1)} g protein per kg lean mass`;
    case 'protein_per_kg': {
      const fat = n('fatPct');
      return `${round(n('proteinGPerKg') ?? 0, 1)} g protein per kg body weight${fat !== undefined ? `, ${round(fat)}% fat` : ''}`;
    }
    default:
      return undefined;
  }
}

function buildGoals(input: BuildCoachSummaryInput): CoachGoals | undefined {
  const rate = finite(input.rateKgPerWeek) ? input.rateKgPerWeek : undefined;
  const type: CoachGoals['type'] | undefined =
    rate === undefined ? undefined : rate <= -0.01 ? 'lose' : rate >= 0.01 ? 'gain' : 'maintain';
  const notes = [
    describeMacroMode(input.macroMode),
    input.energyMode ? `energy mode ${input.energyMode}` : undefined,
    input.netCarbs ? 'tracks net carbs' : undefined,
  ]
    .filter((s): s is string => Boolean(s))
    .join('; ')
    .slice(0, 200);
  const goals: CoachGoals = {
    ...(type ? { type } : {}),
    ...(positive(input.targetWeightKg) ? { targetWeightKg: round(input.targetWeightKg, 1) } : {}),
    ...(type && type !== 'maintain' && rate !== undefined ? { weeklyRateKg: round(Math.abs(rate), 2) } : {}),
    ...(notes ? { notes } : {}),
  };
  return Object.keys(goals).length ? goals : undefined;
}

function buildTargets(t: SummaryTargetsInput | null | undefined): CoachTargets | undefined {
  if (!t) return undefined;
  const out: CoachTargets = {
    ...(positive(t.kcal) ? { kcal: round(t.kcal) } : {}),
    ...(positive(t.proteinG) ? { proteinG: round(t.proteinG) } : {}),
    ...(positive(t.carbsG) ? { carbsG: round(t.carbsG) } : {}),
    ...(positive(t.fatG) ? { fatG: round(t.fatG) } : {}),
    ...(positive(t.fiberG) ? { fiberG: round(t.fiberG) } : {}),
    ...(positive(t.sodiumMg) ? { sodiumMg: round(t.sodiumMg) } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

function buildProfile(p: SummaryProfileInput | null | undefined): CoachSummary['profile'] {
  if (!p) return undefined;
  const out = {
    ...(p.sex ? { sex: p.sex } : {}),
    ...(positive(p.ageYears) ? { ageYears: round(p.ageYears) } : {}),
    ...(positive(p.heightCm) ? { heightCm: round(p.heightCm) } : {}),
    ...(p.activityLevel ? { activityLevel: p.activityLevel } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

/** Maps the resolved targets of the app (structurally typed) to the compact targets the coach sees. */
export function summaryTargetsFrom(resolved: {
  energy: { target: number };
  macros: { protein: { grams: number }; carbs: { grams: number }; fat: { grams: number } };
  nutrients: Partial<Record<string, { min?: number; max?: number } | undefined>>;
}): SummaryTargetsInput {
  return {
    kcal: resolved.energy.target,
    proteinG: resolved.macros.protein.grams,
    carbsG: resolved.macros.carbs.grams,
    fatG: resolved.macros.fat.grams,
    fiberG: resolved.nutrients.FIBER_G?.min,
    sodiumMg: resolved.nutrients.SODIUM_MG?.max,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Public builder
// ---------------------------------------------------------------------------------------------------------------

/** Builds the coach summary from plain rows. Sections without data are omitted (never filled with zeros). */
export function buildCoachSummary(input: BuildCoachSummaryInput): CoachSummary {
  const intake = buildIntake(input);
  const activity = buildActivity(input);
  const sleep = buildSleep(input);
  const weight = buildWeight(input);
  const goals = buildGoals(input);
  const targets = buildTargets(input.targets);
  const profile = buildProfile(input.profile);
  const partialToday = todaySoFar(input);

  return {
    asOf: input.today,
    ...(goals ? { goals } : {}),
    ...(profile ? { profile } : {}),
    ...(targets ? { targets } : {}),
    ...(intake.length ? { intake } : {}),
    ...(weight ? { weight } : {}),
    ...(activity.length ? { activity } : {}),
    ...(sleep.length ? { sleep } : {}),
    ...(partialToday ? { notes: [partialToday] } : {}),
  };
}
