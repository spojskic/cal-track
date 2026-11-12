// Pure formatting helpers for the health sync UI.
import { diffDays, isLocalDate, toLocalDate } from '@/health/dates';
import type { HealthDataType, SyncProgress } from '@/health/types';

/** The collapsed "Connected Apps & Devices" checklist opens with this many rows; every "Show more" adds CHECKLIST_MORE. */
export const CHECKLIST_INITIAL = 2;
export const CHECKLIST_MORE = 5;

/**
 * The data types the checklist shows for an "expanded pages" count (0 = collapsed): the first
 * `CHECKLIST_INITIAL + CHECKLIST_MORE * expandedPages` types, but never fewer than everything up to and
 * including the last ENABLED type - a ticked checkbox must not hide behind "Show more", and the order stays
 * intact.
 */
export function visibleHealthDataTypes(
  all: readonly HealthDataType[],
  enabled: readonly HealthDataType[],
  expandedPages: number,
): readonly HealthDataType[] {
  const lastEnabled = all.reduce((acc, type, index) => (enabled.includes(type) ? index + 1 : acc), 0);
  const paged = CHECKLIST_INITIAL + CHECKLIST_MORE * Math.max(0, expandedPages);
  return all.slice(0, Math.max(paged, lastEnabled));
}

/** 'just now' | '5 min ago' | '3 h ago' | 'yesterday' | '12 Nov 2026' */
export function formatRelativeTime(date: Date, now: Date = new Date()): string {
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24 && toLocalDate(date) === toLocalDate(now)) return `${hours} h ago`;
  const days = diffDays(toLocalDate(date), toLocalDate(now));
  if (days === 1) return 'yesterday';
  if (days > 1 && days < 7) return `${days} days ago`;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatProgress(progress: SyncProgress): string {
  return `Step ${progress.chunkIndex} of ${progress.chunkCount}: ${progress.message}`;
}

export interface BackfillValidation {
  value: string | null;
  error: string | null;
}

/** Validates the backfill date text (YYYY-MM-DD, not in the future, not absurdly old). */
export function validateBackfillDate(text: string, today: string): BackfillValidation {
  const value = text.trim();
  if (!isLocalDate(value)) return { value: null, error: 'Use the format YYYY-MM-DD, e.g. 2026-10-01.' };
  if (value > today) return { value: null, error: 'The date cannot be in the future.' };
  if (diffDays(value, today) > 3650) return { value: null, error: 'Choose a date within the last 10 years.' };
  return { value, error: null };
}
