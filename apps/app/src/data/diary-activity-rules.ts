// Pure rules of deleting + undoing the non-food rows of a diary day (exercise, biometrics, notes). No React, no
// database: unit tested in tools/ui-smoke. The hooks that use them are in diary-activity.ts.
import type { BiometricEntry, ExerciseEntry, NoteEntry } from './activity';

export type ActivityKind = 'exercise' | 'biometric' | 'note';

export type ActivityRow = ExerciseEntry | BiometricEntry | NoteEntry;

/** Columns written back on Undo (user_id is added from the session). */
const RESTORE_COLUMNS: Record<ActivityKind, readonly string[]> = {
  exercise: ['id', 'entry_date', 'activity_code', 'name', 'minutes', 'kcal', 'source', 'external_id', 'started_at', 'ended_at', 'counts_toward_energy'],
  biometric: ['id', 'entry_date', 'type', 'value', 'unit', 'source', 'external_id', 'recorded_at', 'meta'],
  note: ['id', 'entry_date', 'body', 'created_at'],
};

/**
 * Whether a row can be deleted with a swipe. Rows imported from a device (Garmin, Apple Health, Health Connect) are
 * written again by the next sync, so deleting them would only bring them back: they stay read-only here.
 */
export function isSwipeDeletable(kind: ActivityKind, row: object): boolean {
  const source = (row as { source?: unknown }).source;
  return kind === 'note' || source === undefined || source === 'manual';
}

/** The row to insert on Undo: the original columns (same id) for the signed-in user. */
export function buildActivityRestoreRow(kind: ActivityKind, row: object, userId: string): Record<string, unknown> {
  const source = row as Record<string, unknown>;
  const out: Record<string, unknown> = { user_id: userId };
  for (const column of RESTORE_COLUMNS[kind]) {
    if (source[column] !== undefined) out[column] = source[column];
  }
  if (kind === 'biometric' && out.meta == null) out.meta = {};
  return out;
}
