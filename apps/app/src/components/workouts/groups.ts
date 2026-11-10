// Grouping of the workout list: "This week", "Last week", then one section per month ("October 2026"). Pure (unit tested in
// tools/ui-smoke). Weeks start on Monday. Dates are the user's LOCAL calendar days (exercise_entries.entry_date), compared as text.
import { MONTHS_LONG } from './format';

export interface WorkoutSection<T> {
  /** Stable key: "this-week", "last-week" or "2026-10". */
  key: string;
  title: string;
  rows: T[];
}

function parse(date: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  return match ? { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) } : null;
}

const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The Monday of the week that contains `date` (YYYY-MM-DD). Returns `date` unchanged when it is not a date. */
export function weekStart(date: string): string {
  const p = parse(date);
  if (!p) return date;
  const ms = Date.UTC(p.y, p.m - 1, p.d);
  const sinceMonday = (new Date(ms).getUTCDay() + 6) % 7;
  return iso(ms - sinceMonday * 86_400_000);
}

export function addDaysIso(date: string, days: number): string {
  const p = parse(date);
  return p ? iso(Date.UTC(p.y, p.m - 1, p.d) + days * 86_400_000) : date;
}

/** The section a day belongs to, given today's date. A day in the future counts as this week. */
export function sectionOf(date: string, today: string): { key: string; title: string } {
  const p = parse(date);
  if (!p) return { key: 'unknown', title: 'Undated' };
  const thisWeek = weekStart(today);
  if (date >= thisWeek) return { key: 'this-week', title: 'This week' };
  if (date >= addDaysIso(thisWeek, -7)) return { key: 'last-week', title: 'Last week' };
  return { key: `${p.y}-${String(p.m).padStart(2, '0')}`, title: `${MONTHS_LONG[p.m - 1]} ${p.y}` };
}

/**
 * Splits rows (already newest first) into sections in the order they first appear. A section that comes up again later (rows that
 * were not perfectly sorted) is merged into the first one, so a header is never shown twice.
 */
export function groupWorkouts<T extends { entry_date: string }>(rows: readonly T[], today: string): WorkoutSection<T>[] {
  const sections = new Map<string, WorkoutSection<T>>();
  for (const row of rows) {
    const { key, title } = sectionOf(row.entry_date, today);
    const existing = sections.get(key);
    if (existing) existing.rows.push(row);
    else sections.set(key, { key, title, rows: [row] });
  }
  return [...sections.values()];
}

export type ListItem<T> = { type: 'header'; key: string; title: string; count: number } | { type: 'row'; key: string; row: T };

/** Sections flattened for a FlatList: a header item, then its rows. */
export function flattenSections<T extends { id: string }>(sections: readonly WorkoutSection<T>[]): ListItem<T>[] {
  const items: ListItem<T>[] = [];
  for (const section of sections) {
    items.push({ type: 'header', key: `h:${section.key}`, title: section.title, count: section.rows.length });
    for (const row of section.rows) items.push({ type: 'row', key: row.id, row });
  }
  return items;
}
