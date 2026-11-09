// Pure calendar-date math on `YYYY-MM-DD` strings. Uses integer civil-day arithmetic (no Date objects), so it is
// independent of the device time zone and of DST.

import { GarminError } from './errors';

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface Ymd {
  y: number;
  m: number;
  d: number;
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Parses a strict `YYYY-MM-DD`; null when the shape or the calendar day is invalid. */
export function parseYmd(s: unknown): Ymd | null {
  if (typeof s !== 'string') return null;
  const m = YMD.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}

export function isValidYmd(s: unknown): s is string {
  return parseYmd(s) !== null;
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0');
}

export function formatYmd({ y, m, d }: Ymd): string {
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

/** Days since 1970-01-01 of a civil date (Howard Hinnant's algorithm). */
export function toDayNumber({ y, m, d }: Ymd): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function fromDayNumber(z0: number): Ymd {
  const z = z0 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: m <= 2 ? y + 1 : y, m, d };
}

function mustParse(s: string): Ymd {
  const p = parseYmd(s);
  if (!p) throw new GarminError({ kind: 'bad_request', message: `invalid date "${String(s).slice(0, 20)}"`, userMessage: 'That date is not valid.' });
  return p;
}

/** `ymd` shifted by `n` days (may be negative). Throws GarminError(bad_request) for an invalid input date. */
export function addDays(ymd: string, n: number): string {
  return formatYmd(fromDayNumber(toDayNumber(mustParse(ymd)) + n));
}

/** Number of days from `a` to `b` (positive when b is later). */
export function diffDays(a: string, b: string): number {
  return toDayNumber(mustParse(b)) - toDayNumber(mustParse(a));
}

/** Every date from `start` to `end` inclusive (empty when start > end). */
export function eachDate(start: string, end: string): string[] {
  const out: string[] = [];
  const n = diffDays(start, end);
  for (let i = 0; i <= n; i++) out.push(addDays(start, i));
  return out;
}

/** `YYYY-MM-DD` of an epoch-ms instant in UTC. */
export function utcDateOf(ms: number): string {
  return formatYmd(fromDayNumber(Math.floor(ms / 86_400_000)));
}

export interface DateChunk {
  start: string;
  end: string;
}

/**
 * Splits `[start, end]` (both inclusive) into consecutive inclusive chunks of at most `maxDays` calendar days.
 * Empty when start is after end. Throws GarminError(bad_request) on an invalid date or `maxDays < 1`.
 */
export function chunkDateRange(start: string, end: string, maxDays: number): DateChunk[] {
  if (!Number.isInteger(maxDays) || maxDays < 1) {
    throw new GarminError({ kind: 'bad_request', message: 'maxDays must be a positive integer' });
  }
  const total = diffDays(start, end) + 1;
  const chunks: DateChunk[] = [];
  for (let offset = 0; offset < total; offset += maxDays) {
    const len = Math.min(maxDays, total - offset);
    chunks.push({ start: addDays(start, offset), end: addDays(start, offset + len - 1) });
  }
  return chunks;
}

/** Pulls the `YYYY-MM-DD` out of 'YYYY-MM-DD', 'YYYY-MM-DDTHH:mm:ss...' or 'YYYY-MM-DD HH:mm:ss'. */
export function leadingYmd(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const head = s.trim().slice(0, 10);
  return isValidYmd(head) ? head : null;
}
