/**
 * Deterministic coach findings: the FACTS, computed in code from the user's own data.
 *
 * The idea (borrowed from the rules-first coach of a companion project): rules decide what is true, the language
 * model only decides how to say it. Every finding carries
 *   - `claim`    one sentence with the numbers in it,
 *   - `evidence` the figures it rests on, already formatted,
 *   - `basis`    what was counted ("6 logged days of the last 7"), so a claim is always checkable,
 *   - `tone`     good / note / watch (good news is a finding too: a coach that only reports problems is dreaded),
 *   - `priority` 0..100, higher first.
 *
 * Rules of the module:
 *   - Pure functions of plain rows. No I/O, no clock (`today` is an input), no model.
 *   - Nothing is invented. A rule that lacks the data it needs does not fire - it does not fire a weaker version.
 *     What could not be seen is listed by {@link computeUnavailable} so the model can say so instead of guessing.
 *   - A day without a food log is unlogged, never zero.
 *   - Present-tense claims (sleep, HRV, resting heart rate) need data that reaches today (FRESH_DAYS); a watch left
 *     in a drawer produces no new reading, not a bad one.
 *
 * How to add a finding: write a `(ctx) => CoachFinding | null` function, add it to RULES, add a unit test with a
 * hand-built week in coach-findings.test.ts. See docs/coach.md.
 */

import { NUTRIENT_BY_CODE, isNutrientCode } from '@cal/core';

import type { CoachActivityDay, CoachGoals, CoachRecoveryDay, CoachSleepNight, CoachTargets, CoachWeightPoint } from './coach';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FindingTone = 'good' | 'note' | 'watch';

export interface CoachFinding {
  /** Stable slug, e.g. `protein_vs_target`. */
  kind: string;
  tone: FindingTone;
  /** 0..100, higher is more important. */
  priority: number;
  /** One sentence, with the numbers. */
  claim: string;
  /** The figures behind the claim, already formatted. */
  evidence: string[];
  /** What was counted. */
  basis: string;
}

/** One COMPLETED, logged day of food. */
export interface FindingsIntakeDay {
  date: string;
  kcal: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
  fiberG?: number;
  sodiumMg?: number;
  waterMl?: number;
  /** Nutrient code -> amount in catalogue units. Codes no logged food had data for are absent (unknown, not 0). */
  nutrients?: Record<string, number>;
}

export interface NutrientTarget {
  min?: number;
  /** A limit on TOTAL intake. */
  max?: number;
}

export interface FindingsInput {
  /** The user's local date, YYYY-MM-DD. */
  today: string;
  weightKg?: number;
  goal?: CoachGoals;
  targets?: CoachTargets;
  /** Per nutrient code. */
  nutrientTargets?: Record<string, NutrientTarget>;
  /** Resting energy (BMR) in kcal, for the energy balance. */
  bmrKcal?: number;
  /** Completed days with a food log (today is not in here). */
  intake?: FindingsIntakeDay[];
  /** Newest day with any food logged, today included. */
  lastLoggedDate?: string;
  weightPoints?: CoachWeightPoint[];
  sleep?: CoachSleepNight[];
  recovery?: CoachRecoveryDay[];
  /** Up to 28 days of steps, active kcal and workouts (already de-duplicated across sources). */
  activity?: CoachActivityDay[];
  /** True when the app is also sending a detailed description of a workout (heart rate etc.). */
  hasWorkoutDetail?: boolean;
}

export interface ComputeFindingsOptions {
  /** Keep at most this many findings. Default 14. */
  max?: number;
}

// ---------------------------------------------------------------------------
// Thresholds (named, so a test and a reader can see them)
// ---------------------------------------------------------------------------

/** Present-tense watch data (sleep, HRV, resting heart rate) must reach within this many days of today. */
export const FRESH_DAYS = 3;
/** Days of food a window needs before an average is worth quoting. */
export const MIN_LOGGED_DAYS = 3;
/** A micronutrient counts as "consistently low" below this share of its target. */
export const LOW_NUTRIENT_SHARE = 0.7;
/** How many gaps are listed. */
export const MAX_NUTRIENT_GAPS = 5;
/** Sleep guideline for adults (hours). */
export const SLEEP_GOOD_HOURS = 7;
export const SLEEP_LOW_HOURS = 6.5;
/** Weight trend tolerance around the planned rate (kg per week). */
export const WEIGHT_RATE_TOLERANCE = 0.15;
/** Acute : chronic training time above this is a spike (the same 1.5 the reference coach uses for Garmin's ratio). */
export const LOAD_SPIKE_RATIO = 1.5;

/** Handled by their own findings (or not a micronutrient). */
const NOT_MICRO = new Set([
  'ENERGY_KCAL',
  'PROTEIN_G',
  'CARBS_G',
  'NET_CARBS_G',
  'FAT_G',
  'FIBER_G',
  'WATER_G',
  'ALCOHOL_G',
]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const ISO = /^\d{4}-\d{2}-\d{2}/;

function parse(date: string): number {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

/** Whole days from `from` to `to` (to - from). */
function daysBetween(from: string, to: string): number {
  return Math.round((parse(to) - parse(from)) / DAY_MS);
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const valid = (date: string): boolean => typeof date === 'string' && ISO.test(date);

function mean(xs: readonly number[]): number | undefined {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
}

function stdev(xs: readonly number[]): number | undefined {
  const m = mean(xs);
  if (m === undefined || xs.length < 2) return undefined;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

function round(n: number, d = 0): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/** Formats with a fixed number of decimals only when needed: 2340, 84.2, 0.35. */
function fmt(n: number, d = 0): string {
  return String(round(n, d));
}

function signed(n: number, d = 0): string {
  const r = round(n, d);
  return r > 0 ? `+${r}` : String(r);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function when(date: string, today: string): string {
  const d = daysBetween(date, today);
  if (d === 0) return 'today';
  if (d === 1) return 'yesterday';
  return `${d} days ago (${date.slice(0, 10)})`;
}

function inWindow(date: string, today: string, fromDaysAgo: number, toDaysAgo: number): boolean {
  if (!valid(date)) return false;
  const ago = daysBetween(date, today);
  return ago >= toDaysAgo && ago <= fromDaysAgo;
}

function uniqueByDate<T extends { date: string }>(rows: readonly T[]): T[] {
  const map = new Map<string, T>();
  for (const r of rows) if (valid(r.date)) map.set(r.date.slice(0, 10), r);
  return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Least-squares slope of kg over days, in kg per week. */
export function slopeKgPerWeek(points: readonly CoachWeightPoint[]): number | undefined {
  const pts = uniqueByDate(points).filter((p) => finite(p.kg) && p.kg > 0);
  if (pts.length < 2) return undefined;
  const first = pts[0] as CoachWeightPoint;
  const xs = pts.map((p) => daysBetween(first.date, p.date));
  const ys = pts.map((p) => p.kg);
  const mx = mean(xs) as number;
  const my = mean(ys) as number;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += ((xs[i] as number) - mx) * ((ys[i] as number) - my);
    den += ((xs[i] as number) - mx) ** 2;
  }
  return den === 0 ? undefined : (num / den) * 7;
}

// ---------------------------------------------------------------------------
// Shared context
// ---------------------------------------------------------------------------

interface IntakeWindow {
  days: FindingsIntakeDay[];
  /** 7 or 14. */
  windowDays: number;
}

interface Ctx {
  input: FindingsInput;
  today: string;
  /** Logged, completed days, oldest first, de-duplicated, with a positive kcal. */
  intake: FindingsIntakeDay[];
  /** The window used for intake averages: the last 7 days when they hold enough logged days, else the last 14. */
  window: IntakeWindow | null;
  goalType: 'lose' | 'maintain' | 'gain' | undefined;
}

function buildCtx(input: FindingsInput): Ctx {
  const today = input.today;
  const intake = uniqueByDate((input.intake ?? []).filter((d) => finite(d.kcal) && d.kcal > 0)).filter(
    (d) => daysBetween(d.date, today) >= 1 && daysBetween(d.date, today) <= 14,
  );
  const last7 = intake.filter((d) => daysBetween(d.date, today) <= 7);
  let window: IntakeWindow | null = null;
  if (last7.length >= MIN_LOGGED_DAYS) window = { days: last7, windowDays: 7 };
  else if (intake.length >= MIN_LOGGED_DAYS) window = { days: intake, windowDays: 14 };
  return { input, today, intake, window, goalType: input.goal?.type };
}

function basisOf(w: IntakeWindow): string {
  return `${w.days.length} logged ${w.days.length === 1 ? 'day' : 'days'} of the last ${w.windowDays}; unlogged days are left out, not counted as zero`;
}

function avgOf(days: readonly FindingsIntakeDay[], pick: (d: FindingsIntakeDay) => number | undefined): number | undefined {
  return mean(days.map(pick).filter(finite));
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

type Rule = (ctx: Ctx) => CoachFinding | CoachFinding[] | null;

/** The food log stopped: everything below about intake is older than it looks. */
const loggingGap: Rule = ({ input, today, intake }) => {
  const last = input.lastLoggedDate && valid(input.lastLoggedDate) ? input.lastLoggedDate.slice(0, 10) : intake.at(-1)?.date;
  if (!last) return null;
  const gap = daysBetween(last, today);
  if (gap < 2) return null;
  return {
    kind: 'logging_gap',
    tone: 'watch',
    priority: 88,
    claim: `The last food log was ${when(last, today)}, so the intake numbers below are not current.`,
    evidence: [`last logged day: ${last}`, `${gap} days without a log`],
    basis: 'newest day with any food entry',
  };
};

const noIntake: Rule = ({ input, today, intake }) => {
  if (intake.length > 0 || input.lastLoggedDate) return null;
  return {
    kind: 'no_intake_data',
    tone: 'note',
    priority: 60,
    claim: 'There are no completed days of food logging in the last 14 days, so there is nothing to say about intake yet.',
    evidence: ['0 logged days'],
    basis: `food entries from ${shift(today, -14)} to ${shift(today, -1)}`,
  };
};

function shift(date: string, days: number): string {
  return new Date(parse(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Logging coverage and streak: how much to trust the averages, and a pat on the back. */
const loggingCoverage: Rule = ({ intake, today }) => {
  const last14 = intake.filter((d) => daysBetween(d.date, today) <= 14);
  if (last14.length === 0) return null;
  const out: CoachFinding[] = [];
  if (last14.length < 8) {
    out.push({
      kind: 'logging_coverage',
      tone: 'note',
      priority: 48,
      claim: `Food was logged on only ${last14.length} of the last 14 days, so the averages may not match what you really ate.`,
      evidence: [`${last14.length} of 14 days logged`],
      basis: 'completed days with at least one food entry',
    });
  }
  // streak of consecutive logged days ending yesterday (or the day before)
  const dates = new Set(last14.map((d) => d.date));
  let streak = 0;
  let cursor = dates.has(shift(today, -1)) ? shift(today, -1) : dates.has(shift(today, -2)) ? shift(today, -2) : null;
  while (cursor && dates.has(cursor)) {
    streak += 1;
    cursor = shift(cursor, -1);
  }
  if (streak >= 5) {
    out.push({
      kind: 'logging_streak',
      tone: 'good',
      priority: 26,
      claim: `You have logged food ${streak} days in a row.`,
      evidence: [`streak: ${streak} days`],
      basis: 'consecutive completed days with a food log',
    });
  }
  return out.length ? out : null;
};

const caloriesVsTarget: Rule = ({ input, window, goalType }) => {
  const target = input.targets?.kcal;
  if (!window || !finite(target) || target <= 0) return null;
  const kcals = window.days.map((d) => d.kcal);
  const avg = mean(kcals) as number;
  const diff = avg - target;
  const pct = diff / target;
  const over = kcals.filter((k) => k > target * 1.05).length;

  let tone: FindingTone;
  if (Math.abs(pct) <= 0.07) tone = 'good';
  else if (pct > 0) tone = goalType === 'gain' ? 'note' : pct > 0.12 ? 'watch' : 'note';
  else if (goalType === 'gain') tone = pct < -0.12 ? 'watch' : 'note';
  else tone = pct < -0.2 ? 'watch' : 'note';

  const protein = avgOf(window.days, (d) => d.proteinG);
  const carbs = avgOf(window.days, (d) => d.carbsG);
  const fat = avgOf(window.days, (d) => d.fatG);
  const evidence = [
    `average ${fmt(avg)} kcal/day`,
    `target ${fmt(target)} kcal`,
    `${signed(diff)} kcal (${signed(pct * 100)}%)`,
    `${over} of ${window.days.length} days over target`,
    `lowest day ${fmt(Math.min(...kcals))}, highest ${fmt(Math.max(...kcals))} kcal`,
  ];
  if (finite(protein) && finite(carbs) && finite(fat) && avg > 0) {
    evidence.push(
      `share of kcal: ${fmt(((protein * 4) / avg) * 100)}% protein / ${fmt(((carbs * 4) / avg) * 100)}% carbs / ${fmt(((fat * 9) / avg) * 100)}% fat`,
    );
  }
  const verb = Math.abs(pct) <= 0.07 ? 'on target' : diff > 0 ? 'above target' : 'below target';
  return {
    kind: 'calories_vs_target',
    tone,
    priority: tone === 'watch' ? 80 : tone === 'note' ? 66 : 40,
    claim: `Calories average ${fmt(avg)} kcal/day against a ${fmt(target)} kcal target: ${verb} (${signed(diff)} kcal).`,
    evidence,
    basis: basisOf(window),
  };
};

const proteinVsTarget: Rule = ({ input, window }) => {
  const target = input.targets?.proteinG;
  if (!window || !finite(target) || target <= 0) return null;
  const grams = window.days.map((d) => d.proteinG).filter(finite);
  if (grams.length < MIN_LOGGED_DAYS) return null;
  const avg = mean(grams) as number;
  const share = avg / target;
  const hit = grams.filter((g) => g >= target * 0.9).length;
  const kg = input.weightKg;
  const tone: FindingTone = share >= 0.95 ? 'good' : share >= 0.8 ? 'note' : 'watch';
  const evidence = [
    `average ${fmt(avg)} g/day`,
    `target ${fmt(target)} g`,
    `${fmt(share * 100)}% of target`,
    `${hit} of ${grams.length} days at 90% of target or more`,
  ];
  if (finite(kg) && kg > 0) {
    evidence.splice(1, 0, `${fmt(avg / kg, 2)} g/kg at ${fmt(kg, 1)} kg`, `target ${fmt(target / kg, 2)} g/kg`);
  }
  return {
    kind: 'protein_vs_target',
    tone,
    priority: tone === 'watch' ? 85 : tone === 'note' ? 64 : 36,
    claim:
      tone === 'good'
        ? `Protein is on target: ${fmt(avg)} g/day against ${fmt(target)} g.`
        : `Protein averages ${fmt(avg)} g/day against a ${fmt(target)} g target (${fmt(share * 100)}%).`,
    evidence,
    basis: basisOf(window),
  };
};

const fiberVsTarget: Rule = ({ input, window }) => {
  const target = input.targets?.fiberG;
  if (!window || !finite(target) || target <= 0) return null;
  const avg = avgOf(window.days, (d) => d.fiberG);
  if (!finite(avg)) return null;
  const share = avg / target;
  if (share >= 0.9 && share < 1) return null;
  const tone: FindingTone = share >= 1 ? 'good' : share >= 0.7 ? 'note' : 'watch';
  return {
    kind: 'fiber_vs_target',
    tone,
    priority: tone === 'watch' ? 58 : tone === 'note' ? 50 : 20,
    claim: `Fiber averages ${fmt(avg, 1)} g/day against ${fmt(target)} g (${fmt(share * 100)}%).`,
    evidence: [`average ${fmt(avg, 1)} g/day`, `target ${fmt(target)} g`],
    basis: basisOf(window),
  };
};

interface NutrientStat {
  code: string;
  name: string;
  unit: string;
  avg: number;
  daysWithData: number;
  daysLow: number;
  min?: number;
  max?: number;
}

function nutrientValue(d: FindingsIntakeDay, code: string): number | undefined {
  const v = d.nutrients?.[code];
  if (finite(v)) return v;
  if (code === 'SODIUM_MG' && finite(d.sodiumMg)) return d.sodiumMg;
  return undefined;
}

/** Average per nutrient over the days that have data for it. Only nutrients that have a target. */
function nutrientStats(ctx: Ctx): NutrientStat[] {
  const { window, input } = ctx;
  if (!window || !input.nutrientTargets) return [];
  const out: NutrientStat[] = [];
  for (const [code, target] of Object.entries(input.nutrientTargets)) {
    if (!isNutrientCode(code) || NOT_MICRO.has(code)) continue;
    const hasMin = finite(target.min) && target.min > 0;
    const hasMax = finite(target.max) && target.max > 0;
    if (!hasMin && !hasMax) continue;
    const values = window.days.map((d) => nutrientValue(d, code)).filter(finite);
    if (values.length < MIN_LOGGED_DAYS) continue;
    const def = NUTRIENT_BY_CODE[code];
    out.push({
      code,
      name: def.shortName ?? def.name,
      unit: def.unit,
      avg: mean(values) as number,
      daysWithData: values.length,
      daysLow: hasMin ? values.filter((v) => v < (target.min as number) * LOW_NUTRIENT_SHARE).length : 0,
      ...(hasMin ? { min: target.min } : {}),
      ...(hasMax ? { max: target.max } : {}),
    });
  }
  return out;
}

const share = (n: NutrientStat): number => (n.min ? n.avg / n.min : Number.POSITIVE_INFINITY);

const micronutrientGaps: Rule = (ctx) => {
  const { window } = ctx;
  if (!window) return null;
  const low = nutrientStats(ctx)
    .filter((n) => n.min !== undefined && share(n) < LOW_NUTRIENT_SHARE && n.daysLow * 2 >= n.daysWithData)
    .sort((a, b) => share(a) - share(b))
    .slice(0, MAX_NUTRIENT_GAPS);
  if (low.length === 0) return null;
  const worst = share(low[0] as NutrientStat);
  const tone: FindingTone = worst < 0.4 ? 'watch' : 'note';
  const label = (n: NutrientStat) => `${n.name} ${fmt(share(n) * 100)}% (${fmt(n.avg, n.avg < 10 ? 1 : 0)} of ${fmt(n.min as number, (n.min as number) < 10 ? 1 : 0)} ${n.unit})`;
  return {
    kind: 'micronutrient_gaps',
    tone,
    priority: low.filter((n) => share(n) < 0.5).length >= 3 ? 76 : tone === 'watch' ? 70 : 58,
    claim: `Consistently below ${fmt(LOW_NUTRIENT_SHARE * 100)}% of target: ${low.map(label).join(', ')}.`,
    evidence: low.map((n) => `${n.name}: ${fmt(n.avg, n.avg < 10 ? 1 : 0)} ${n.unit}/day average, ${n.daysLow} of ${n.daysWithData} days under ${fmt(LOW_NUTRIENT_SHARE * 100)}%`),
    basis: `${basisOf(window)}; only days where a logged food had data for the nutrient are counted, so a gap can also be incomplete food data`,
  };
};

const limitsExceeded: Rule = (ctx) => {
  const { window } = ctx;
  if (!window) return null;
  const over = nutrientStats(ctx)
    .filter((n) => n.max !== undefined && n.avg > (n.max as number))
    .sort((a, b) => b.avg / (b.max as number) - a.avg / (a.max as number))
    .slice(0, MAX_NUTRIENT_GAPS);
  if (over.length === 0) return null;
  const label = (n: NutrientStat) => `${n.name} ${fmt((n.avg / (n.max as number)) * 100)}% (${fmt(n.avg)} of ${fmt(n.max as number)} ${n.unit})`;
  return {
    kind: 'limits_exceeded',
    tone: 'watch',
    priority: 78,
    claim: `Above the daily upper limit on average: ${over.map(label).join(', ')}.`,
    evidence: over.map((n) => `${n.name}: ${fmt(n.avg)} ${n.unit}/day average, limit ${fmt(n.max as number)} ${n.unit}`),
    basis: basisOf(window),
  };
};

const weightTrend: Rule = ({ input, today, goalType }) => {
  const pts = uniqueByDate((input.weightPoints ?? []).filter((p) => finite(p.kg) && p.kg > 0 && daysBetween(p.date, today) >= 0));
  if (pts.length === 0) return null;
  const last = pts.at(-1) as CoachWeightPoint;
  const age = daysBetween(last.date, today);
  const out: CoachFinding[] = [];
  const recent = pts.filter((p) => daysBetween(p.date, today) <= 35);
  const span = recent.length >= 2 ? daysBetween((recent[0] as CoachWeightPoint).date, (recent.at(-1) as CoachWeightPoint).date) : 0;

  if (age > 14) {
    out.push({
      kind: 'weight_stale',
      tone: 'note',
      priority: 44,
      claim: `The last weigh-in was ${when(last.date, today)} (${fmt(last.kg, 1)} kg), so the weight trend is not current.`,
      evidence: [`last weigh-in ${last.date.slice(0, 10)}: ${fmt(last.kg, 1)} kg`],
      basis: 'newest weigh-in',
    });
    return out;
  }
  if (recent.length < 3 || span < 10) return null;

  const slope = slopeKgPerWeek(recent) as number;
  const first = recent[0] as CoachWeightPoint;
  const rate = input.goal?.weeklyRateKg;
  const planned = goalType === 'lose' && finite(rate) ? -Math.abs(rate) : goalType === 'gain' && finite(rate) ? Math.abs(rate) : goalType === 'maintain' ? 0 : undefined;
  const bw = last.kg;

  let tone: FindingTone = 'note';
  let verdict = '';
  if (planned !== undefined) {
    const delta = slope - planned;
    if (goalType === 'lose' && slope < -0.01 * bw) {
      tone = 'watch';
      verdict = 'faster than about 1% of body weight per week';
    } else if (Math.abs(delta) <= WEIGHT_RATE_TOLERANCE) {
      tone = 'good';
      verdict = 'on the planned pace';
    } else if (goalType === 'lose') {
      tone = slope >= 0 && span >= 21 ? 'watch' : 'note';
      verdict = delta > 0 ? 'slower than planned' : 'faster than planned';
    } else if (goalType === 'gain') {
      tone = delta < 0 && span >= 21 && slope <= 0 ? 'watch' : 'note';
      verdict = delta < 0 ? 'slower than planned' : 'faster than planned';
    } else {
      tone = 'note';
      verdict = slope > 0 ? 'drifting up' : 'drifting down';
    }
  } else {
    verdict = Math.abs(slope) < 0.1 ? 'roughly flat' : slope > 0 ? 'rising' : 'falling';
  }

  const evidence = [
    `trend ${signed(slope, 2)} kg/week`,
    `${fmt(first.kg, 1)} kg on ${first.date.slice(0, 10)} to ${fmt(last.kg, 1)} kg on ${last.date.slice(0, 10)}`,
  ];
  if (planned !== undefined) evidence.push(`planned ${signed(planned, 2)} kg/week`);
  const target = input.goal?.targetWeightKg;
  if (finite(target) && Math.abs(slope) > 0.03) {
    const toGo = target - last.kg;
    if (Math.sign(toGo) === Math.sign(slope) && Math.abs(toGo) > 0.2) {
      const weeks = Math.abs(toGo / slope);
      if (weeks <= 104) evidence.push(`${fmt(Math.abs(toGo), 1)} kg to the ${fmt(target, 1)} kg target, about ${fmt(weeks)} weeks at this pace`);
    }
  }
  return [
    ...out,
    {
      kind: 'weight_trend',
      tone,
      priority: tone === 'watch' ? 82 : tone === 'note' ? 62 : 38,
      claim: `Weight trend is ${signed(slope, 2)} kg/week (${verdict}), now ${fmt(last.kg, 1)} kg.`,
      evidence,
      basis: `${plural(recent.length, 'weigh-in')} over ${span} days; a straight-line fit, single readings move with water`,
    },
  ];
};

/** Eaten vs burned on the days that have both food and watch data. */
const energyBalance: Rule = ({ input, today, intake }) => {
  const bmr = input.bmrKcal;
  if (!finite(bmr) || bmr <= 0) return null;
  const active = new Map<string, number>();
  for (const a of input.activity ?? []) {
    if (valid(a.date) && finite(a.activeKcal) && a.activeKcal > 0 && daysBetween(a.date, today) <= 14) active.set(a.date.slice(0, 10), a.activeKcal);
  }
  const both = intake.filter((d) => active.has(d.date) && daysBetween(d.date, today) <= 14);
  if (both.length < 4) return null;
  const eaten = mean(both.map((d) => d.kcal)) as number;
  const act = mean(both.map((d) => active.get(d.date) as number)) as number;
  const burned = bmr + act;
  const balance = eaten - burned;
  const kgPerWeek = (balance * 7) / 7700;
  return {
    kind: 'energy_balance',
    tone: 'note',
    priority: 56,
    claim: `On days with food and watch data you ate about ${fmt(eaten)} kcal and burned about ${fmt(burned)} (resting ${fmt(bmr)} + active ${fmt(act)}): ${signed(balance)} kcal/day, roughly ${signed(kgPerWeek, 2)} kg/week.`,
    evidence: [
      `eaten ${fmt(eaten)} kcal/day`,
      `resting energy ${fmt(bmr)} kcal (formula estimate)`,
      `active energy ${fmt(act)} kcal/day (watch estimate)`,
      `balance ${signed(balance)} kcal/day`,
    ],
    basis: `${plural(both.length, 'day')} with both a food log and watch active energy; both burn figures are estimates`,
  };
};

const sleepDuration: Rule = ({ input, today }) => {
  const nights = uniqueByDate((input.sleep ?? []).filter((n) => finite(n.hours) && n.hours > 0 && daysBetween(n.date, today) >= 0));
  if (nights.length === 0) return null;
  const latest = nights.at(-1) as CoachSleepNight;
  if (daysBetween(latest.date, today) > FRESH_DAYS) return null;
  const last7 = nights.filter((n) => daysBetween(n.date, today) <= 6);
  if (last7.length < MIN_LOGGED_DAYS) return null;
  const hours = last7.map((n) => n.hours);
  const avg = mean(hours) as number;
  const under6 = hours.filter((h) => h < 6).length;
  const tone: FindingTone = avg >= SLEEP_GOOD_HOURS ? 'good' : avg >= SLEEP_LOW_HOURS ? 'note' : 'watch';
  const scores = last7.map((n) => n.quality).filter(finite);
  const evidence = [
    `average ${fmt(avg, 1)} h/night`,
    `range ${fmt(Math.min(...hours), 1)} to ${fmt(Math.max(...hours), 1)} h`,
    `${plural(under6, 'night')} under 6 h`,
    `last night recorded: ${fmt(latest.hours, 1)} h on ${latest.date.slice(0, 10)}`,
  ];
  if (scores.length >= 3) evidence.push(`average sleep score ${fmt(mean(scores) as number)}`);
  return {
    kind: 'sleep_duration',
    tone,
    priority: tone === 'watch' ? 79 : tone === 'note' ? 54 : 30,
    claim: `Sleep averages ${fmt(avg, 1)} h/night over the last week${tone === 'good' ? ', in the healthy range' : tone === 'watch' ? ', short for recovery' : ', a little under 7 h'}.`,
    evidence,
    basis: `${plural(last7.length, 'recorded night')} of the last 7`,
  };
};

const sleepConsistency: Rule = ({ input, today }) => {
  const nights = uniqueByDate((input.sleep ?? []).filter((n) => finite(n.hours) && n.hours > 0 && daysBetween(n.date, today) >= 0 && daysBetween(n.date, today) <= 13));
  if (nights.length < 7) return null;
  if (daysBetween((nights.at(-1) as CoachSleepNight).date, today) > FRESH_DAYS) return null;
  const sd = stdev(nights.map((n) => n.hours)) as number;
  if (sd < 1.25) return null;
  const hours = nights.map((n) => n.hours);
  return {
    kind: 'sleep_consistency',
    tone: 'note',
    priority: 46,
    claim: `Sleep length is uneven: it varies by about ${fmt(sd, 1)} h from night to night (${fmt(Math.min(...hours), 1)} to ${fmt(Math.max(...hours), 1)} h).`,
    evidence: [`standard deviation ${fmt(sd, 1)} h`, `shortest ${fmt(Math.min(...hours), 1)} h, longest ${fmt(Math.max(...hours), 1)} h`],
    basis: `${plural(nights.length, 'recorded night')} of the last 14`,
  };
};

function recoverySeries(input: FindingsInput, today: string, pick: (r: CoachRecoveryDay) => number | undefined) {
  const rows = uniqueByDate(input.recovery ?? [])
    .filter((r) => daysBetween(r.date, today) >= 0)
    .map((r) => ({ date: r.date, value: pick(r) }))
    .filter((r): r is { date: string; value: number } => finite(r.value));
  const recent = rows.filter((r) => daysBetween(r.date, today) <= 6);
  const baseline = rows.filter((r) => daysBetween(r.date, today) >= 7 && daysBetween(r.date, today) <= 27);
  const fresh = rows.length > 0 && daysBetween((rows.at(-1) as { date: string }).date, today) <= FRESH_DAYS;
  return { recent, baseline, fresh };
}

const hrvTrend: Rule = ({ input, today }) => {
  const { recent, baseline, fresh } = recoverySeries(input, today, (r) => r.hrv);
  if (!fresh || recent.length < 3 || baseline.length < 5) return null;
  const now = mean(recent.map((r) => r.value)) as number;
  const base = mean(baseline.map((r) => r.value)) as number;
  const change = (now - base) / base;
  if (Math.abs(change) < 0.1) return null;
  const down = change < 0;
  return {
    kind: 'hrv_trend',
    tone: down ? 'watch' : 'good',
    priority: down ? 74 : 38,
    claim: `HRV is ${down ? 'down' : 'up'} ${fmt(Math.abs(change) * 100)}%: ${fmt(now)} ms this week against a ${fmt(base)} ms baseline.`,
    evidence: [`last 7 days average ${fmt(now)} ms`, `baseline ${fmt(base)} ms`, `change ${signed(change * 100)}%`],
    basis: `${recent.length} readings this week against ${baseline.length} readings from the 3 weeks before (the measuring method differs by device, compare only your own numbers)`,
  };
};

const restingHrTrend: Rule = ({ input, today }) => {
  const { recent, baseline, fresh } = recoverySeries(input, today, (r) => r.restingHr);
  if (!fresh || recent.length < 3 || baseline.length < 5) return null;
  const now = mean(recent.map((r) => r.value)) as number;
  const base = mean(baseline.map((r) => r.value)) as number;
  const diff = now - base;
  if (diff < 3 && diff > -3) return null;
  const up = diff > 0;
  return {
    kind: 'resting_hr_trend',
    tone: up ? 'watch' : 'good',
    priority: up ? 70 : 30,
    claim: `Resting heart rate is ${fmt(now)} bpm this week, ${up ? 'up' : 'down'} ${fmt(Math.abs(diff))} bpm from a ${fmt(base)} bpm baseline.`,
    evidence: [`last 7 days average ${fmt(now)} bpm`, `baseline ${fmt(base)} bpm`, `change ${signed(diff)} bpm`],
    basis: `${recent.length} readings this week against ${baseline.length} readings from the 3 weeks before`,
  };
};

interface Session {
  date: string;
  type: string;
  minutes?: number;
  kcal?: number;
  avgHr?: number;
  maxHr?: number;
}

function sessions(input: FindingsInput, today: string): Session[] {
  const out: Session[] = [];
  for (const a of input.activity ?? []) {
    if (!valid(a.date) || daysBetween(a.date, today) < 0 || daysBetween(a.date, today) > 27) continue;
    for (const w of a.workouts ?? []) out.push({ date: a.date.slice(0, 10), type: w.type, minutes: w.minutes, kcal: w.kcal, avgHr: w.avgHr, maxHr: w.maxHr });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

const trainingFrequency: Rule = ({ input, today }) => {
  const all = sessions(input, today);
  const week = all.filter((s) => daysBetween(s.date, today) <= 6);
  const prior = all.filter((s) => daysBetween(s.date, today) >= 7);
  const minutesOf = (xs: Session[]) => xs.reduce((a, s) => a + (finite(s.minutes) ? s.minutes : 0), 0);
  const kcalOf = (xs: Session[]) => xs.reduce((a, s) => a + (finite(s.kcal) ? s.kcal : 0), 0);
  const out: CoachFinding[] = [];

  if (all.length === 0) return null; // "no workouts in 4 weeks" is reported by computeUnavailable

  const last = all.at(-1) as Session;
  const since = daysBetween(last.date, today);
  const perWeek28 = all.length / 4;

  if (week.length === 0 && prior.length >= 4) {
    out.push({
      kind: 'training_gap',
      tone: 'watch',
      priority: 62,
      claim: `No workout in the last ${since} days (last: ${last.type} ${when(last.date, today)}), after about ${fmt(perWeek28, 1)} sessions a week before that.`,
      evidence: [`${plural(all.length, 'session')} in the last 28 days`, `last workout ${last.date}`],
      basis: 'workouts from every connected source, de-duplicated',
    });
  } else if (week.length > 0) {
    const tone: FindingTone = week.length >= 3 ? 'good' : 'note';
    const evidence = [
      `${plural(week.length, 'session')}, ${fmt(minutesOf(week))} min, ${fmt(kcalOf(week))} kcal in the last 7 days`,
      `28-day average ${fmt(perWeek28, 1)} sessions/week`,
    ];
    out.push({
      kind: 'training_frequency',
      tone,
      priority: tone === 'good' ? 34 : 40,
      claim: `${plural(week.length, 'workout')} in the last 7 days (${fmt(minutesOf(week))} min); the 28-day average is ${fmt(perWeek28, 1)} a week.`,
      evidence,
      basis: `workouts of the last 28 days, ${plural(all.length, 'session')} in total`,
    });
    // load spike: this week's minutes against the average of the 3 weeks before
    const priorWeekly = minutesOf(prior) / 3;
    const ratio = priorWeekly > 0 ? minutesOf(week) / priorWeekly : 0;
    if (priorWeekly >= 60 && ratio >= LOAD_SPIKE_RATIO) {
      out.push({
        kind: 'load_spike',
        tone: 'watch',
        priority: 72,
        claim: `Training time this week (${fmt(minutesOf(week))} min) is ${fmt(ratio, 1)}x your usual ${fmt(priorWeekly)} min a week.`,
        evidence: [`this week ${fmt(minutesOf(week))} min`, `average of the 3 weeks before ${fmt(priorWeekly)} min`, `ratio ${fmt(ratio, 1)}`],
        basis: 'minutes of recorded workouts, 7 days against the 21 days before',
      });
    }
  }
  return out.length ? out : null;
};

const lastWorkout: Rule = ({ input, today }) => {
  const all = sessions(input, today);
  const last = all.at(-1);
  if (!last) return null;
  const sameDay = all.filter((s) => s.date === last.date);
  const evidence: string[] = [];
  const parts = sameDay.map((s) => {
    const bits = [s.type];
    if (finite(s.minutes)) bits.push(`${fmt(s.minutes)} min`);
    if (finite(s.kcal) && s.kcal > 0) bits.push(`${fmt(s.kcal)} kcal`);
    if (finite(s.avgHr)) bits.push(`avg HR ${fmt(s.avgHr)}`);
    if (finite(s.maxHr)) bits.push(`max HR ${fmt(s.maxHr)}`);
    return bits.join(', ');
  });
  const hasHr = sameDay.some((s) => finite(s.avgHr) || finite(s.maxHr));
  if (!hasHr) {
    evidence.push(input.hasWorkoutDetail ? 'more detail (heart rate etc.) is in the workout section below' : 'no heart-rate figure is available for it');
  }
  return {
    kind: 'last_workout',
    tone: 'note',
    priority: 57,
    claim: `Last workout ${when(last.date, today)}: ${parts.join('; ')}.`,
    evidence,
    basis: 'the most recent day with a recorded workout',
  };
};

const stepsTrend: Rule = ({ input, today }) => {
  const rows = uniqueByDate(input.activity ?? []).filter((a) => finite(a.steps) && (a.steps as number) > 0 && daysBetween(a.date, today) >= 0);
  const recent = rows.filter((a) => daysBetween(a.date, today) <= 6).map((a) => a.steps as number);
  const prior = rows.filter((a) => daysBetween(a.date, today) >= 7 && daysBetween(a.date, today) <= 27).map((a) => a.steps as number);
  if (recent.length < 4 || prior.length < 7) return null;
  const now = mean(recent) as number;
  const base = mean(prior) as number;
  const change = (now - base) / base;
  if (Math.abs(change) < 0.25) return null;
  const down = change < 0;
  return {
    kind: 'steps_trend',
    tone: down ? 'note' : 'good',
    priority: down ? 50 : 24,
    claim: `Daily steps are ${down ? 'down' : 'up'} ${fmt(Math.abs(change) * 100)}%: ${fmt(now)} this week against ${fmt(base)} before.`,
    evidence: [`last 7 days ${fmt(now)} steps/day`, `3 weeks before ${fmt(base)} steps/day`],
    basis: `${recent.length} days this week, ${prior.length} days before`,
  };
};

const hydration: Rule = ({ input, today, intake }) => {
  const rows = intake.filter((d) => finite(d.waterMl) && (d.waterMl as number) > 0 && daysBetween(d.date, today) <= 7);
  if (rows.length < MIN_LOGGED_DAYS) return null;
  const avg = mean(rows.map((d) => d.waterMl as number)) as number;
  const target = input.targets?.waterMl;
  const share = finite(target) && target > 0 ? avg / target : undefined;
  return {
    kind: 'hydration',
    tone: 'note',
    priority: share !== undefined && share < 0.7 ? 46 : 22,
    claim:
      share !== undefined
        ? `Logged water averages ${fmt(avg)} ml/day against a ${fmt(target as number)} ml target (${fmt(share * 100)}%).`
        : `Logged water averages ${fmt(avg)} ml/day.`,
    evidence: [`average ${fmt(avg)} ml/day`, ...(share !== undefined ? [`target ${fmt(target as number)} ml`] : []), 'drinks other than logged water are not counted'],
    basis: `${plural(rows.length, 'day')} with logged water of the last 7`,
  };
};

const RULES: readonly Rule[] = [
  loggingGap,
  noIntake,
  loggingCoverage,
  caloriesVsTarget,
  proteinVsTarget,
  fiberVsTarget,
  micronutrientGaps,
  limitsExceeded,
  weightTrend,
  energyBalance,
  sleepDuration,
  sleepConsistency,
  hrvTrend,
  restingHrTrend,
  trainingFrequency,
  lastWorkout,
  stepsTrend,
  hydration,
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * All findings the data supports, most important first. Usually 4 to 10. Never throws on odd input: a rule that
 * cannot run on the data it got simply does not fire.
 */
export function computeCoachFindings(input: FindingsInput, opts: ComputeFindingsOptions = {}): CoachFinding[] {
  if (!valid(input.today)) return [];
  const ctx = buildCtx(input);
  const out: CoachFinding[] = [];
  for (const rule of RULES) {
    try {
      const r = rule(ctx);
      if (Array.isArray(r)) out.push(...r);
      else if (r) out.push(r);
    } catch {
      // a broken rule must never take the coach down; the others still run
    }
  }
  return out
    .map((f, i) => ({ f, i }))
    .sort((a, b) => b.f.priority - a.f.priority || a.i - b.i)
    .map(({ f }) => f)
    .slice(0, opts.max ?? 14);
}

/**
 * What the app could NOT see, so the model says so instead of guessing. Short phrases, most relevant first.
 */
export function computeUnavailable(input: FindingsInput): string[] {
  if (!valid(input.today)) return [];
  const today = input.today;
  const out: string[] = [];
  const intakeDays = (input.intake ?? []).filter((d) => finite(d.kcal) && d.kcal > 0);
  if (intakeDays.length === 0) out.push('food intake (nothing logged on the last 14 completed days)');
  else if (intakeDays.length < MIN_LOGGED_DAYS) out.push(`food intake averages (only ${plural(intakeDays.length, 'logged day')} in the last 14)`);

  const weights = (input.weightPoints ?? []).filter((p) => valid(p.date) && finite(p.kg));
  if (weights.length === 0) out.push('weight (no weigh-ins in the last 6 weeks)');

  const nights = (input.sleep ?? []).filter((n) => valid(n.date));
  const lastNight = uniqueByDate(nights).at(-1);
  if (!lastNight) out.push('sleep (no recorded nights in the last 14 days)');
  else if (daysBetween(lastNight.date, today) > FRESH_DAYS) out.push(`sleep (the newest night is ${lastNight.date.slice(0, 10)}, ${daysBetween(lastNight.date, today)} days ago)`);

  const rec = uniqueByDate(input.recovery ?? []);
  if (!rec.some((r) => finite(r.hrv))) out.push('HRV');
  if (!rec.some((r) => finite(r.restingHr))) out.push('resting heart rate');

  if (sessions(input, today).length === 0) out.push('workouts (none recorded in the last 28 days)');
  else if (!input.hasWorkoutDetail && !(input.activity ?? []).some((a) => (a.workouts ?? []).some((w) => finite(w.avgHr) || finite(w.maxHr)))) {
    out.push('heart rate and effort of workouts (only duration and calories are recorded)');
  }
  return out.slice(0, 6);
}

/** One line of text for a finding, as it appears in the data block. */
export function formatFinding(f: CoachFinding): string {
  const ev = f.evidence.length ? ` [${f.evidence.join('; ')}]` : '';
  return `[${f.tone}] ${f.claim}${ev} Counted: ${f.basis}.`;
}

// ---------------------------------------------------------------------------
// Per-nutrient table for the data block
// ---------------------------------------------------------------------------

export interface CoachNutrientRow {
  name: string;
  unit: string;
  /** Average per day over the days that had data. */
  avg: number;
  min?: number;
  max?: number;
  /** avg / min, 0..n */
  pctOfMin?: number;
  days: number;
}

/**
 * Average intake against target for the nutrients with a target, the ones furthest below their minimum first,
 * then the ones over their limit. At most `limit` rows.
 */
export function computeNutrientRows(input: FindingsInput, limit = 12): CoachNutrientRow[] {
  if (!valid(input.today)) return [];
  const stats = nutrientStats(buildCtx(input));
  const rows = stats.map((n): CoachNutrientRow => ({
    name: n.name,
    unit: n.unit,
    avg: n.avg,
    ...(n.min !== undefined ? { min: n.min, pctOfMin: n.avg / n.min } : {}),
    ...(n.max !== undefined ? { max: n.max } : {}),
    days: n.daysWithData,
  }));
  const lowFirst = rows
    .filter((r) => r.pctOfMin !== undefined && r.pctOfMin < 1)
    .sort((a, b) => (a.pctOfMin as number) - (b.pctOfMin as number));
  const over = rows.filter((r) => r.max !== undefined && r.avg > (r.max as number));
  const seen = new Set<string>();
  const out: CoachNutrientRow[] = [];
  for (const r of [...lowFirst, ...over]) {
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    out.push(r);
  }
  return out.slice(0, limit);
}
