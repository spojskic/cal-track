import { fromISODate, todayISO } from '@/state/selected-date';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "Sun, Nov 8" (adds the year when it is not the current one). Locale independent. */
export function formatDayLabel(iso: string): string {
  const d = fromISODate(iso);
  const base = `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date().getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

/** "Today" / "Yesterday" / "Tomorrow" for the adjacent days, otherwise undefined. */
export function relativeDayLabel(iso: string): string | undefined {
  const today = fromISODate(todayISO()).getTime();
  const days = Math.round((fromISODate(iso).getTime() - today) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === -1) return 'Yesterday';
  if (days === 1) return 'Tomorrow';
  return undefined;
}

/** Single-letter weekday for compact charts. */
export function weekdayInitial(iso: string): string {
  return (WEEKDAYS[fromISODate(iso).getDay()] ?? '').slice(0, 1);
}
