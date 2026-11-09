// Chooses the date range of a sync run. Pure.
import { addDays, diffDays, localDateOfIso, maxDate, minDate } from './dates';
import { defaultBackfillDate } from './settings';
import type { DateRange, LocalDate } from './types';

export type SyncMode = 'incremental' | 'backfill';

/** Incremental runs re-read today and the two days before it (late-arriving data from watches). */
export const INCREMENTAL_OVERLAP_DAYS = 2;
/** An incremental run never reaches back further than this; use Backfill for older gaps. */
export const MAX_INCREMENTAL_DAYS = 30;

export interface PlanInput {
  mode: SyncMode;
  today: LocalDate;
  /** `integrations.backfill_date` */
  backfillDate: LocalDate | null;
  /** `integrations.last_sync_at` */
  lastSyncAt: string | null;
  /** Health Connect: days readable before the first grant when no extended history permission exists. */
  historyLimitDays?: number;
  extendedHistory: boolean;
  /** When the user first granted access. */
  connectedAt: string | null;
}

export interface PlanResult {
  range: DateRange;
  warnings: string[];
}

export function planSyncRange(input: PlanInput): PlanResult {
  const { today } = input;
  const warnings: string[] = [];
  const backfillFrom = minDate(input.backfillDate ?? defaultBackfillDate(today), today);

  let from: LocalDate;
  if (input.mode === 'backfill' || !input.lastSyncAt) {
    from = backfillFrom;
  } else {
    const lastDay = localDateOfIso(input.lastSyncAt) ?? backfillFrom;
    from = minDate(addDays(today, -INCREMENTAL_OVERLAP_DAYS), addDays(lastDay, -1));
    from = maxDate(from, addDays(today, -MAX_INCREMENTAL_DAYS));
    from = maxDate(from, backfillFrom);
  }

  if (input.historyLimitDays && !input.extendedHistory) {
    const anchor = (input.connectedAt && localDateOfIso(input.connectedAt)) || today;
    const earliest = addDays(anchor, -(input.historyLimitDays - 1));
    if (from < earliest) {
      from = earliest;
      warnings.push(
        `Health Connect only lets Cal Track read the ${input.historyLimitDays} days before you first connected ` +
          `(from ${earliest}). Older days were skipped.`,
      );
    }
  }

  return { range: { from: minDate(from, today), to: today }, warnings };
}

/**
 * True when a backfill starting at `backfillDate` reaches beyond the platform's default history window (Health
 * Connect: the 30 days before the first permission grant), so the extended history permission is worth asking for.
 */
export function needsExtendedHistory(
  historyLimitDays: number | undefined,
  backfillDate: LocalDate,
  today: LocalDate,
): boolean {
  if (!historyLimitDays) return false;
  return diffDays(backfillDate, today) > historyLimitDays - 1;
}
