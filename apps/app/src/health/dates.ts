// Local-calendar-day helpers. Pure: everything is built from y/m/d so DST changes never shift a day.
import type { DateRange, LocalDate } from './types';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

interface Ymd {
  y: number;
  m: number; // 1-12
  d: number;
}

export function parseLocalDate(value: string): Ymd | null {
  const match = DATE_RE.exec(value);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const check = new Date(y, m - 1, d);
  // Rejects 2026-02-31 (the Date constructor would roll it over).
  if (check.getFullYear() !== y || check.getMonth() !== m - 1 || check.getDate() !== d) return null;
  return { y, m, d };
}

export function isLocalDate(value: string): boolean {
  return parseLocalDate(value) !== null;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** The device-local calendar day of an instant. */
export function toLocalDate(date: Date): LocalDate {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function todayLocal(now: Date = new Date()): LocalDate {
  return toLocalDate(now);
}

/** Local calendar day of an ISO timestamp (or any Date-parsable string). Returns null when unparsable. */
export function localDateOfIso(iso: string): LocalDate | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? toLocalDate(new Date(ms)) : null;
}

function requireYmd(value: LocalDate): Ymd {
  const ymd = parseLocalDate(value);
  if (!ymd) throw new Error(`Invalid local date: ${value}`);
  return ymd;
}

/** Local time `hours:minutes` on `date`. */
export function localDateAt(date: LocalDate, hours = 0, minutes = 0): Date {
  const { y, m, d } = requireYmd(date);
  return new Date(y, m - 1, d, hours, minutes, 0, 0);
}

export const startOfLocalDay = (date: LocalDate): Date => localDateAt(date, 0, 0);

export function addDays(date: LocalDate, days: number): LocalDate {
  const { y, m, d } = requireYmd(date);
  return toLocalDate(new Date(y, m - 1, d + days));
}

/** Calendar days from `a` to `b` (b - a), unaffected by DST. */
export function diffDays(a: LocalDate, b: LocalDate): number {
  const x = requireYmd(a);
  const y = requireYmd(b);
  return Math.round((Date.UTC(y.y, y.m - 1, y.d) - Date.UTC(x.y, x.m - 1, x.d)) / 86_400_000);
}

export const maxDate = (a: LocalDate, b: LocalDate): LocalDate => (a >= b ? a : b);
export const minDate = (a: LocalDate, b: LocalDate): LocalDate => (a <= b ? a : b);

/** [start of `from`, start of the day after `to`) as local instants. */
export function rangeBounds(range: DateRange): { start: Date; endExclusive: Date } {
  return { start: startOfLocalDay(range.from), endExclusive: startOfLocalDay(addDays(range.to, 1)) };
}

export function eachDay(range: DateRange): LocalDate[] {
  const out: LocalDate[] = [];
  const total = diffDays(range.from, range.to);
  for (let i = 0; i <= total; i++) out.push(addDays(range.from, i));
  return out;
}

/**
 * Splits `range` into chunks of at most `chunkDays` days, NEWEST FIRST (today's data shows up first during a long
 * backfill). Chunks are anchored at `range.to`.
 */
export function chunkRangeNewestFirst(range: DateRange, chunkDays: number): DateRange[] {
  const size = Math.max(1, Math.floor(chunkDays));
  const chunks: DateRange[] = [];
  let to = range.to;
  while (to >= range.from) {
    const from = maxDate(addDays(to, -(size - 1)), range.from);
    chunks.push({ from, to });
    to = addDays(from, -1);
  }
  return chunks;
}

/** Local-day key of an epoch-ms instant. */
export const localDateOfMs = (ms: number): LocalDate => toLocalDate(new Date(ms));
