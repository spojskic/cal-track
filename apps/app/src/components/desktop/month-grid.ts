// Pure (no React Native imports): the date maths of the sidebar calendar. A month is shown as six weeks of seven days, Monday first (the
// grid never changes height when the user pages from month to month), with the days of the neighbouring months dimmed.
//
// Only local calendar dates are used (YYYY-MM-DD, the key the diary uses): a day is built from year / month / day numbers at noon, so a
// daylight-saving change or the time zone of the machine can never shift a cell to another date.

/** A month, with `month` from 1 (January) to 12. */
export interface MonthRef {
  year: number;
  month: number;
}

export interface MonthCell {
  /** YYYY-MM-DD */
  iso: string;
  /** Day of the month, 1-31. */
  day: number;
  /** False for the dimmed days of the previous / next month. */
  inMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
}

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Monday first. */
export const WEEKDAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;
export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

export const WEEKS_SHOWN = 6;
export const DAYS_PER_WEEK = 7;

const pad = (n: number): string => String(n).padStart(2, '0');

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parses YYYY-MM-DD. Null for anything else (including 2026-02-31). */
export function parseIsoDate(iso: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(year, month - 1, day, 12);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day ? { year, month, day } : null;
}

/** The month a date is in. A value that is not a date gives `fallback` (the month of today). */
export function monthOf(iso: string, fallback: MonthRef): MonthRef {
  const parsed = parseIsoDate(iso);
  return parsed ? { year: parsed.year, month: parsed.month } : fallback;
}

export function sameMonth(a: MonthRef, b: MonthRef): boolean {
  return a.year === b.year && a.month === b.month;
}

/** The month `delta` months away (negative: earlier), across year ends. */
export function shiftMonth(ref: MonthRef, delta: number): MonthRef {
  const index = ref.year * 12 + (ref.month - 1) + delta;
  return { year: Math.floor(index / 12), month: (((index % 12) + 12) % 12) + 1 };
}

/** "November 2026" */
export function monthTitle(ref: MonthRef): string {
  return `${MONTH_NAMES[ref.month - 1] ?? ''} ${ref.year}`;
}

/** "9 November 2026": the accessible name of a day cell. */
export function dayLabel(iso: string): string {
  const parsed = parseIsoDate(iso);
  return parsed ? `${parsed.day} ${MONTH_NAMES[parsed.month - 1]} ${parsed.year}` : iso;
}

/** Number of days the first of the month is after the Monday that starts its first row: 0 when it is a Monday, 6 when a Sunday. */
export function leadingDays(ref: MonthRef): number {
  const weekday = new Date(ref.year, ref.month - 1, 1, 12).getDay(); // 0 = Sunday
  return (weekday + 6) % DAYS_PER_WEEK;
}

/** The six weeks of a month, Monday first, with today and the selected date marked. */
export function buildMonthGrid(ref: MonthRef, marks: { today: string; selected: string }): MonthCell[][] {
  const start = 1 - leadingDays(ref);
  const weeks: MonthCell[][] = [];
  for (let w = 0; w < WEEKS_SHOWN; w++) {
    const week: MonthCell[] = [];
    for (let d = 0; d < DAYS_PER_WEEK; d++) {
      const date = new Date(ref.year, ref.month - 1, start + w * DAYS_PER_WEEK + d, 12);
      const iso = isoOf(date);
      week.push({
        iso,
        day: date.getDate(),
        inMonth: date.getMonth() === ref.month - 1 && date.getFullYear() === ref.year,
        isToday: iso === marks.today,
        isSelected: iso === marks.selected,
      });
    }
    weeks.push(week);
  }
  return weeks;
}
