// Tolerant JSON pickers shared by the mappers: several candidate names per value, dotted paths, numeric strings, and a
// FieldTracker that counts which JSON key satisfied which canonical field (the data behind the "sync report").
// NOTHING in here throws on unexpected input and nothing records a VALUE: only key names, counts and reasons.

import { leadingYmd, toDayNumber, utcDateOf } from './dates';
import type {
  GarminDiagnostic,
  GarminDiagnosticReason,
  GarminFieldCoverage,
} from './normalized';

export type Obj = Record<string, unknown>;

export function isObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(${v.length})`;
  return typeof v;
}

// ---------------------------------------------------------------------------------------------------------------------
// Low-level pickers
// ---------------------------------------------------------------------------------------------------------------------

export interface Resolved {
  value: unknown;
  /** The key (or dotted path) as it actually appears in the JSON. */
  key: string;
}

function ownKey(o: Obj, key: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(o, key)) return key;
  const lower = key.toLowerCase();
  for (const k of Object.keys(o)) if (k.toLowerCase() === lower) return k;
  return undefined;
}

/** Resolves a name or dotted path (case-insensitive fallback per segment). Null/undefined/'' count as absent. */
export function resolve(obj: unknown, path: string): Resolved | undefined {
  if (!isObject(obj)) return undefined;
  const direct = ownKey(obj, path);
  if (direct !== undefined) {
    const v = obj[direct];
    return v === null || v === undefined || v === '' ? undefined : { value: v, key: direct };
  }
  if (!path.includes('.')) return undefined;
  let cur: unknown = obj;
  const actual: string[] = [];
  for (const seg of path.split('.')) {
    if (!isObject(cur)) return undefined;
    const k = ownKey(cur, seg);
    if (k === undefined) return undefined;
    actual.push(k);
    cur = cur[k];
  }
  return cur === null || cur === undefined || cur === '' ? undefined : { value: cur, key: actual.join('.') };
}

/** A finite number from a number or a numeric string. Booleans, NaN, Infinity and '' give undefined. */
export function toFiniteNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    let s = v.trim();
    if (s === '') return undefined;
    if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
    if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function toNonEmptyString(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? undefined : t;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

/** First candidate name (or dotted path) whose value is a usable number; undefined when none. */
export function pickNumber(obj: unknown, names: readonly string[]): number | undefined {
  for (const name of names) {
    const r = resolve(obj, name);
    if (r) {
      const n = toFiniteNumber(r.value);
      if (n !== undefined) return n;
    }
  }
  return undefined;
}

/** First candidate name (or dotted path) whose value is a non-empty string (numbers are stringified). */
export function pickString(obj: unknown, names: readonly string[]): string | undefined {
  for (const name of names) {
    const r = resolve(obj, name);
    if (r) {
      const s = toNonEmptyString(r.value);
      if (s !== undefined) return s;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Timestamps and units
// ---------------------------------------------------------------------------------------------------------------------

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/**
 * Parses a Garmin timestamp to epoch milliseconds.
 *  - strings like '2026-11-09 06:30:00', '2026-11-09T06:30:00.0Z', '...+01:00' (an explicit offset is honoured);
 *  - numbers / numeric strings: epoch milliseconds, or epoch seconds when below 1e11.
 * A string WITHOUT an offset is read as UTC for `kind: 'gmt'` (the `...GMT` fields). For `kind: 'local'` (the `...Local`
 * fields) the result is the local wall-clock time encoded as if it were UTC (a "floating" time): use it to read the local
 * date/time of day, not as a real instant. Returns undefined for anything unparseable.
 */
export function parseGarminTimestamp(value: unknown, kind: 'gmt' | 'local' = 'gmt'): number | undefined {
  void kind; // same arithmetic for both; the distinction documents how the result must be interpreted
  const asNumber = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d{9,}\s*$/.test(value) ? Number(value) : undefined;
  if (asNumber !== undefined) {
    if (!Number.isFinite(asNumber) || asNumber <= 0) return undefined;
    if (asNumber >= 1e11) return Math.round(asNumber);
    if (asNumber >= 1e9) return Math.round(asNumber * 1000);
    return undefined;
  }
  if (typeof value !== 'string') return undefined;
  const m = TS_RE.exec(value.trim());
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const hh = m[4] === undefined ? 0 : Number(m[4]);
  const mi = m[5] === undefined ? 0 : Number(m[5]);
  const ss = m[6] === undefined ? 0 : Number(m[6]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 59) return undefined;
  // Reject impossible days such as 2026-02-31 via a round trip.
  const dayNo = toDayNumber({ y, m: mo, d });
  if (utcDateOf(dayNo * 86_400_000) !== `${m[1]}-${m[2]}-${m[3]}`) return undefined;
  const frac = m[7] === undefined ? 0 : Math.round(Number(`0.${m[7]}`) * 1000);
  let ms = dayNo * 86_400_000 + hh * 3_600_000 + mi * 60_000 + ss * 1000 + frac;
  const off = m[8];
  if (off && off.toUpperCase() !== 'Z') {
    const sign = off.startsWith('-') ? -1 : 1;
    const digits = off.slice(1).replace(':', '');
    const oh = Number(digits.slice(0, 2));
    const om = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
    ms -= sign * (oh * 3_600_000 + om * 60_000);
  }
  return ms;
}

/** Garmin reports body weight in grams (e.g. 72500); a value above 1000 is treated as grams, otherwise as kg. */
export function weightToKg(v: number): number {
  const kg = v > 1000 ? v / 1000 : v;
  return Math.round(kg * 1000) / 1000;
}

/** True when `weightToKg` will divide by 1000. */
export function weightIsGrams(v: number): boolean {
  return v > 1000;
}

export function secondsToMinutes(sec: number): number {
  return Math.round(sec / 60);
}

/** Hours with 2 decimals. */
export function secondsToHours(sec: number): number {
  return Math.round((sec / 3600) * 100) / 100;
}

export function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

// ---------------------------------------------------------------------------------------------------------------------
// Field tracker: picks values, counts hits/misses, builds diagnostics + coverage
// ---------------------------------------------------------------------------------------------------------------------

interface FieldStat {
  total: number;
  found: number;
  missing: number;
  wrong: number;
  implausible: number;
  optional: boolean;
  tried: readonly string[];
  matchedBy: Map<string, number>;
  sample: Partial<Record<'missing' | 'wrong' | 'implausible', string>>;
  implausibleDetail?: string;
  wrongDetail?: string;
}

export interface PickOptions {
  /** The date of the item, used as the example in diagnostics. */
  date?: string;
  /** Do not report `missing` for this field (it is normally absent for some items). Coverage still counts it. */
  optional?: boolean;
  min?: number;
  max?: number;
  /** When true, `min` itself is also rejected (value must be > min). */
  minExclusive?: boolean;
  /** Round the picked number to this many decimals. */
  decimals?: number;
}

export class FieldTracker {
  private readonly stats = new Map<string, FieldStat>();
  private readonly notes = new Map<string, GarminDiagnostic>();
  /** Items examined by `item()` (for `of`). */
  items = 0;

  constructor(readonly endpoint: string) {}

  /** Call once per examined item. */
  item(): void {
    this.items += 1;
  }

  private stat(field: string, tried: readonly string[], optional: boolean): FieldStat {
    let s = this.stats.get(field);
    if (!s) {
      s = { total: 0, found: 0, missing: 0, wrong: 0, implausible: 0, optional, tried, matchedBy: new Map(), sample: {} };
      this.stats.set(field, s);
    } else if (!optional) {
      s.optional = false;
    }
    return s;
  }

  private track<T>(
    obj: unknown,
    field: string,
    names: readonly string[],
    convert: (raw: unknown) => T | undefined,
    check: (value: T) => string | undefined,
    opts: PickOptions,
  ): T | undefined {
    const s = this.stat(field, names, opts.optional === true);
    s.total += 1;
    let sawWrong: string | undefined;
    for (const name of names) {
      const r = resolve(obj, name);
      if (!r) continue;
      const value = convert(r.value);
      if (value === undefined) {
        sawWrong ??= `${r.key}=${describeType(r.value)}`;
        continue;
      }
      const problem = check(value);
      if (problem) {
        s.implausible += 1;
        s.implausibleDetail ??= `${r.key}: ${problem}`;
        if (opts.date) s.sample.implausible ??= opts.date;
        return undefined;
      }
      s.found += 1;
      s.matchedBy.set(r.key, (s.matchedBy.get(r.key) ?? 0) + 1);
      return value;
    }
    if (sawWrong !== undefined) {
      s.wrong += 1;
      s.wrongDetail ??= sawWrong;
      if (opts.date) s.sample.wrong ??= opts.date;
    } else {
      s.missing += 1;
      if (opts.date) s.sample.missing ??= opts.date;
    }
    return undefined;
  }

  number(obj: unknown, field: string, names: readonly string[], opts: PickOptions = {}): number | undefined {
    return this.track(
      obj,
      field,
      names,
      toFiniteNumber,
      (n) => {
        if (opts.min !== undefined && (opts.minExclusive ? n <= opts.min : n < opts.min)) return `${n} below ${opts.min}`;
        if (opts.max !== undefined && n > opts.max) return `${n} above ${opts.max}`;
        return undefined;
      },
      opts,
    ) as number | undefined;
  }

  /** Like `number`, then rounds to `opts.decimals` (default: not rounded). */
  rounded(obj: unknown, field: string, names: readonly string[], opts: PickOptions = {}): number | undefined {
    const n = this.number(obj, field, names, opts);
    return n === undefined || opts.decimals === undefined ? n : round(n, opts.decimals);
  }

  string(obj: unknown, field: string, names: readonly string[], opts: PickOptions = {}): string | undefined {
    return this.track(obj, field, names, toNonEmptyString, () => undefined, opts);
  }

  /** A calendar date: 'YYYY-MM-DD' or any string that starts with one. */
  date(obj: unknown, field: string, names: readonly string[], opts: PickOptions = {}): string | undefined {
    return this.track(obj, field, names, (v) => leadingYmd(v) ?? undefined, () => undefined, opts);
  }

  /** Epoch milliseconds from a timestamp string/number. */
  timestamp(
    obj: unknown,
    field: string,
    names: readonly string[],
    kind: 'gmt' | 'local',
    opts: PickOptions = {},
  ): number | undefined {
    return this.track(obj, field, names, (v) => parseGarminTimestamp(v, kind), () => undefined, opts);
  }

  /** Records a free-form observation (counted per endpoint/field/reason). */
  note(field: string, reason: GarminDiagnosticReason, detail?: string, sampleDate?: string): void {
    const key = `${field}|${reason}`;
    const existing = this.notes.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    this.notes.set(key, {
      endpoint: this.endpoint,
      field,
      reason,
      count: 1,
      ...(detail !== undefined ? { detail } : {}),
      ...(sampleDate !== undefined ? { sampleDate } : {}),
    });
  }

  diagnostics(): GarminDiagnostic[] {
    const out: GarminDiagnostic[] = [];
    for (const [field, s] of this.stats) {
      const base = { endpoint: this.endpoint, field, of: s.total };
      if (s.missing > 0 && !s.optional) {
        out.push({
          ...base,
          reason: 'missing',
          count: s.missing,
          detail: `none of: ${s.tried.join(', ')}`,
          ...(s.sample.missing ? { sampleDate: s.sample.missing } : {}),
        });
      }
      if (s.wrong > 0) {
        out.push({
          ...base,
          reason: 'wrong_type',
          count: s.wrong,
          ...(s.wrongDetail ? { detail: s.wrongDetail } : {}),
          ...(s.sample.wrong ? { sampleDate: s.sample.wrong } : {}),
        });
      }
      if (s.implausible > 0) {
        out.push({
          ...base,
          reason: 'implausible',
          count: s.implausible,
          ...(s.implausibleDetail ? { detail: s.implausibleDetail } : {}),
          ...(s.sample.implausible ? { sampleDate: s.sample.implausible } : {}),
        });
      }
    }
    for (const n of this.notes.values()) out.push({ ...n, ...(n.field !== '$' && !n.of && this.items ? { of: this.items } : {}) });
    return out.sort((a, b) => a.field.localeCompare(b.field) || a.reason.localeCompare(b.reason));
  }

  coverage(): GarminFieldCoverage[] {
    return [...this.stats.entries()].map(([field, s]) => ({
      endpoint: this.endpoint,
      field,
      total: s.total,
      found: s.found,
      matchedBy: Object.fromEntries(s.matchedBy),
      tried: [...s.tried],
    }));
  }
}

/** Sums diagnostics that share (endpoint, field, reason). The first detail/sampleDate wins. */
export function mergeDiagnostics(...lists: ReadonlyArray<readonly GarminDiagnostic[]>): GarminDiagnostic[] {
  const map = new Map<string, GarminDiagnostic>();
  for (const list of lists) {
    for (const d of list) {
      const key = `${d.endpoint}|${d.field}|${d.reason}`;
      const cur = map.get(key);
      if (!cur) {
        map.set(key, { ...d });
      } else {
        cur.count += d.count;
        if (d.of !== undefined) cur.of = (cur.of ?? 0) + d.of;
        cur.detail ??= d.detail;
        cur.sampleDate ??= d.sampleDate;
      }
    }
  }
  return [...map.values()];
}

/** Sums coverage that shares (endpoint, field). */
export function mergeCoverage(...lists: ReadonlyArray<readonly GarminFieldCoverage[]>): GarminFieldCoverage[] {
  const map = new Map<string, GarminFieldCoverage>();
  for (const list of lists) {
    for (const c of list) {
      const key = `${c.endpoint}|${c.field}`;
      const cur = map.get(key);
      if (!cur) {
        map.set(key, { ...c, matchedBy: { ...c.matchedBy }, tried: [...c.tried] });
      } else {
        cur.total += c.total;
        cur.found += c.found;
        for (const [k, n] of Object.entries(c.matchedBy)) cur.matchedBy[k] = (cur.matchedBy[k] ?? 0) + n;
        for (const name of c.tried) if (!cur.tried.includes(name)) cur.tried.push(name);
      }
    }
  }
  return [...map.values()];
}

// ---------------------------------------------------------------------------------------------------------------------
// Containers (a reply that is a bare array, an object that wraps an array, or a single item)
// ---------------------------------------------------------------------------------------------------------------------

export function findArray(obj: Obj, keys: readonly string[], depth: number): unknown[] | null | undefined {
  for (const k of keys) {
    const key = ownKey(obj, k);
    if (key === undefined) continue;
    const v = obj[key];
    if (Array.isArray(v)) return v;
    if (v === null) return null;
    if (depth > 0 && isObject(v)) {
      const nested = findArray(v, keys, depth - 1);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

export interface ContainerSpec {
  /** Property names that may hold the array. */
  keys: readonly string[];
  /** If the top-level object has one of these properties, it is itself a single item. */
  itemHints: readonly string[];
}

/** The object items of a reply. Notes anything unexpected on the tracker (key NAMES only, never values). */
export function extractItems(raw: unknown, t: FieldTracker, spec: ContainerSpec): Obj[] {
  let list: unknown[];
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (isObject(raw)) {
    const found = findArray(raw, spec.keys, 1);
    if (found === null) return [];
    if (found) {
      list = found;
    } else if (spec.itemHints.some((h) => ownKey(raw, h) !== undefined)) {
      list = [raw];
    } else if (Object.keys(raw).length === 0) {
      return [];
    } else {
      t.note(
        '$',
        'unexpected_shape',
        `expected an array or an object with one of [${spec.keys.join(', ')}], got an object with keys: ${Object.keys(raw).slice(0, 8).join(', ')}`,
      );
      return [];
    }
  } else {
    t.note('$', 'unexpected_shape', `expected an array or object, got ${describeType(raw)}`);
    return [];
  }
  const out: Obj[] = [];
  for (const el of list) {
    if (!isObject(el)) {
      t.note('$item', 'unexpected_shape', `array item is ${describeType(el)}, expected an object`);
      continue;
    }
    out.push(el);
  }
  return out;
}

/** Keeps the last item per key (later responses win). */
export function dedupe<T>(items: T[], keyOf: (t: T) => string): T[] {
  const map = new Map<string, T>();
  for (const it of items) map.set(keyOf(it), it);
  return [...map.values()];
}
