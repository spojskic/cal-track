import { useLocalSearchParams } from 'expo-router';

import { fromISODate, toISODate, useSelectedDate } from '@/state/selected-date';

/** True for a real calendar date written as YYYY-MM-DD. */
export function isValidISODate(value: unknown): value is string {
  return (
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && toISODate(fromISODate(value)) === value
  );
}

/** The diary date an activity screen writes to: the `date` route param when valid, else the selected date. */
export function useTargetDate(): string {
  const { date } = useLocalSearchParams<{ date?: string }>();
  const selected = useSelectedDate((s) => s.date);
  return isValidISODate(date) ? date : selected;
}
