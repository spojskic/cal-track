// Copy / paste / bulk delete of diary entries: the pure row builders and the plain async functions behind the hooks
// in diary.ts and diary-actions.ts. Free of React so the mock-backend contract tests can call them directly.
//
// Foods are immutable and an entry only stores (food_id, grams, display amount/portion, note): copying therefore
// creates NEW diary_entries rows and never touches foods.
import { requireUserId } from '@/lib/auth-user';
import { supabase } from '@/lib/supabase';
import { isUuid } from '@/lib/uuid';

// ---------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------

/** What a copy carries over from a diary entry. */
export interface CopyItem {
  foodId: string;
  grams: number;
  /** Display amount in a portion unit (with {@link portionLabel}); both null for a plain gram amount. */
  amount: number | null;
  portionLabel: string | null;
  note: string | null;
  /** Meal group of the source entry; used when the target group is not forced. */
  mealGroupId?: string | null;
}

/** A clipboard item also remembers what to call the food. */
export interface ClipboardItem extends CopyItem {
  name: string;
  brand: string | null;
}

export type ClipboardKind = 'group' | 'entry';

/** The in-app clipboard of "Copy Group" / "Copy Entry". */
export interface DiaryClipboard {
  kind: ClipboardKind;
  /** "Breakfast" for a group, the food name for an entry. */
  label: string;
  sourceDate: string;
  sourceGroupId: string | null;
  items: ClipboardItem[];
}

/** The minimal shape of a diary entry the clipboard needs (a {@link DiaryEntry} satisfies it). */
export interface ClipboardSourceEntry {
  foodId: string;
  grams: number;
  amount: number | null;
  portionLabel: string | null;
  note: string | null;
  mealGroupId: string | null;
  food: { name: string; brand: string | null };
}

/** A row ready for `diary_entries.insert`. */
export interface DiaryInsertRow {
  user_id: string;
  entry_date: string;
  meal_group_id: string | null;
  food_id: string;
  grams: number;
  amount: number | null;
  portion_label: string | null;
  note: string | null;
  source: 'copy';
  logged_at: string;
}

/** A complete diary_entries row, as needed to put a deleted entry back exactly as it was. */
export interface DiarySnapshotRow {
  id: string;
  user_id: string;
  entry_date: string;
  meal_group_id: string | null;
  food_id: string;
  grams: number;
  amount: number | null;
  portion_label: string | null;
  source: string;
  ai_confidence: number | null;
  note: string | null;
  logged_at: string;
}

export interface CopyDiaryEntriesInput {
  fromDate: string;
  toDate: string;
  /** Copy only this meal group of the source day. Omit to copy the whole day (groups are preserved). */
  fromMealGroupId?: string;
  /** Target group for a single-group copy (defaults to the same group id). */
  toMealGroupId?: string;
}

/** Result of a copy / paste. `ids` are the inserted rows (what Undo removes). */
export interface CopyOutcome {
  count: number;
  ids: string[];
  toDate: string;
  /** Items that were left out because they were not valid (no food, grams <= 0, ...). */
  skipped: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------

/** "item" / "items". */
export const itemWord = (n: number): string => (n === 1 ? 'item' : 'items');

const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** True for a real calendar date written as YYYY-MM-DD (so not "2026-02-31" and not "2026-2-3"). */
export function isValidISODate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** True when `date` is a valid day strictly before `today` (ISO dates compare as strings). */
export function isPastDate(date: string, today: string): boolean {
  return isValidISODate(date) && isValidISODate(today) && date < today;
}

/** A usable copy item, or null when it could not become a valid diary row (no food, grams not above 0). */
export function toCopyItem(raw: {
  foodId: unknown;
  grams: unknown;
  amount?: unknown;
  portionLabel?: unknown;
  note?: unknown;
  mealGroupId?: unknown;
}): CopyItem | null {
  if (!isUuid(typeof raw.foodId === 'string' ? raw.foodId : null)) return null;
  const grams = typeof raw.grams === 'string' ? Number(raw.grams) : raw.grams;
  if (!positive(grams)) return null;
  const amountRaw = typeof raw.amount === 'string' ? Number(raw.amount) : raw.amount;
  const label = typeof raw.portionLabel === 'string' && raw.portionLabel.trim() !== '' ? raw.portionLabel : null;
  // The display amount and its unit only make sense together.
  const portion = positive(amountRaw) && label !== null;
  return {
    foodId: raw.foodId as string,
    grams,
    amount: portion ? (amountRaw as number) : null,
    portionLabel: portion ? label : null,
    note: typeof raw.note === 'string' && raw.note !== '' ? raw.note : null,
    mealGroupId: isUuid(typeof raw.mealGroupId === 'string' ? raw.mealGroupId : null) ? (raw.mealGroupId as string) : null,
  };
}

export interface BuildCopyRowsInput {
  userId: string;
  /** Local YYYY-MM-DD the copies are dated. */
  toDate: string;
  items: readonly CopyItem[];
  /**
   * Meal group of every new row. `undefined` keeps the group of each source item, `null` means "no group".
   */
  mealGroupId?: string | null;
  /** Epoch ms of the first row's `logged_at`; later rows are 1 ms apart so the source order is kept. */
  now?: number;
}

/**
 * Turns copy items into insert rows. Throws for an invalid user / date / target group (nothing must be written);
 * items that could not be a valid row are left out. Every row is a NEW entry with source 'copy'.
 */
export function buildCopyRows(input: BuildCopyRowsInput): DiaryInsertRow[] {
  if (!isUuid(input.userId)) throw new Error('You are signed out. Please sign in again.');
  if (!isValidISODate(input.toDate)) throw new Error(`Invalid date: ${String(input.toDate)}`);
  if (input.mealGroupId !== undefined && input.mealGroupId !== null && !isUuid(input.mealGroupId)) {
    throw new Error('Invalid meal group.');
  }
  const base = input.now ?? Date.now();
  const rows: DiaryInsertRow[] = [];
  for (const item of input.items) {
    const valid = toCopyItem(item);
    if (!valid) continue;
    rows.push({
      user_id: input.userId,
      entry_date: input.toDate,
      meal_group_id: input.mealGroupId !== undefined ? input.mealGroupId : (valid.mealGroupId ?? null),
      food_id: valid.foodId,
      grams: valid.grams,
      amount: valid.amount,
      portion_label: valid.portionLabel,
      note: valid.note,
      source: 'copy',
      logged_at: new Date(base + rows.length).toISOString(),
    });
  }
  return rows;
}

/**
 * Meal group a paste / copy lands in: `preferred` when it is one of the user's groups, else `fallback`, else the first
 * visible group. With no groups loaded yet `preferred` is trusted; null only when there is nothing to choose from.
 */
export function resolveTargetGroup(
  preferred: string | null | undefined,
  groups: readonly { id: string; hidden?: boolean }[],
  fallback?: string | null,
): string | null {
  if (groups.length === 0) return preferred ?? fallback ?? null;
  if (preferred && groups.some((g) => g.id === preferred)) return preferred;
  if (fallback && groups.some((g) => g.id === fallback)) return fallback;
  return (groups.find((g) => !g.hidden) ?? groups[0])?.id ?? null;
}

/** A clipboard for the given entries, or null when none of them can be pasted. */
export function makeClipboard(args: {
  kind: ClipboardKind;
  label: string;
  sourceDate: string;
  sourceGroupId: string | null;
  entries: readonly ClipboardSourceEntry[];
}): DiaryClipboard | null {
  const items: ClipboardItem[] = [];
  for (const entry of args.entries) {
    const item = toCopyItem(entry);
    if (item) items.push({ ...item, name: entry.food.name, brand: entry.food.brand });
  }
  if (items.length === 0) return null;
  return { kind: args.kind, label: args.label, sourceDate: args.sourceDate, sourceGroupId: args.sourceGroupId, items };
}

/** Label of the paste action for what is on the clipboard. */
export const pasteLabel = (clip: Pick<DiaryClipboard, 'kind'>): string => (clip.kind === 'group' ? 'Paste Group' : 'Paste Entry');

/** Entries ordered by the time they were logged (oldest first, or newest first); ties keep a stable order by id. */
export function sortEntriesByTime<T extends { id: string; loggedAt: string }>(
  entries: readonly T[],
  newestFirst = false,
): T[] {
  const time = (e: T) => {
    const t = Date.parse(e.loggedAt);
    return Number.isFinite(t) ? t : 0;
  };
  const direction = newestFirst ? -1 : 1;
  return entries.slice().sort((a, b) => direction * (time(a) - time(b)) || direction * a.id.localeCompare(b.id));
}

/**
 * Rows to put back after an undone delete. The user id is forced to the signed-in user, rows that could not be valid
 * (grams not above 0, bad ids or date) are left out.
 */
export function buildRestoreRows(rows: readonly DiarySnapshotRow[], userId: string): DiarySnapshotRow[] {
  if (!isUuid(userId)) throw new Error('You are signed out. Please sign in again.');
  const out: DiarySnapshotRow[] = [];
  for (const row of rows) {
    if (!isUuid(row.id) || !isUuid(row.food_id) || !isValidISODate(row.entry_date) || !positive(Number(row.grams))) continue;
    out.push({
      ...row,
      user_id: userId,
      grams: Number(row.grams),
      meal_group_id: isUuid(row.meal_group_id) ? row.meal_group_id : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Async (plain functions; the hooks only add cache handling)
// ---------------------------------------------------------------------------------------------------------------

const COPY_SELECT = 'meal_group_id,food_id,grams,amount,portion_label,note';
const SNAPSHOT_SELECT = 'id,user_id,entry_date,meal_group_id,food_id,grams,amount,portion_label,source,ai_confidence,note,logged_at';

interface CopyRow {
  meal_group_id: string | null;
  food_id: string;
  grams: number | string;
  amount: number | string | null;
  portion_label: string | null;
  note: string | null;
}

/** Entries of one day (optionally one meal group) in the order they were logged, as copy items. */
export async function fetchCopyItems(date: string, mealGroupId?: string): Promise<CopyItem[]> {
  if (!isValidISODate(date)) throw new Error(`Invalid date: ${String(date)}`);
  let query = supabase
    .from('diary_entries')
    .select(COPY_SELECT)
    .eq('entry_date', date)
    .order('logged_at', { ascending: true });
  if (mealGroupId) query = query.eq('meal_group_id', mealGroupId);
  const { data, error } = await query;
  if (error) throw error;
  const items: CopyItem[] = [];
  for (const row of (data ?? []) as unknown as CopyRow[]) {
    const item = toCopyItem({
      foodId: row.food_id,
      grams: row.grams,
      amount: row.amount,
      portionLabel: row.portion_label,
      note: row.note,
      mealGroupId: row.meal_group_id,
    });
    if (item) items.push(item);
  }
  return items;
}

/** Inserts rows and returns the new ids. */
export async function insertCopyRows(rows: readonly DiaryInsertRow[]): Promise<string[]> {
  if (rows.length === 0) return [];
  const { data, error } = await supabase.from('diary_entries').insert(rows.slice()).select('id');
  if (error) throw error;
  return ((data ?? []) as { id: string }[]).map((r) => r.id);
}

async function insertItems(
  input: { userId: string; toDate: string; items: readonly CopyItem[]; mealGroupId?: string | null },
  now: number | undefined,
): Promise<CopyOutcome> {
  const rows = buildCopyRows({ ...input, ...(now !== undefined ? { now } : {}) });
  const ids = await insertCopyRows(rows);
  return { count: ids.length, ids, toDate: input.toDate, skipped: input.items.length - rows.length };
}

/**
 * Copies a meal group (or a whole day) of `fromDate` into `toDate` as new entries. A group copy lands in
 * `toMealGroupId` (default: the same group); a whole-day copy keeps each entry's group.
 */
export async function copyFromDay(input: CopyDiaryEntriesInput, now?: number): Promise<CopyOutcome> {
  if (!isValidISODate(input.fromDate) || !isValidISODate(input.toDate)) throw new Error('Invalid date.');
  if (input.fromDate === input.toDate) throw new Error('Choose a different day to copy from.');
  const userId = await requireUserId();
  const items = await fetchCopyItems(input.fromDate, input.fromMealGroupId);
  if (items.length === 0) return { count: 0, ids: [], toDate: input.toDate, skipped: 0 };
  const forced = input.fromMealGroupId ? (input.toMealGroupId ?? input.fromMealGroupId) : undefined;
  return insertItems({ userId, toDate: input.toDate, items, ...(forced !== undefined ? { mealGroupId: forced } : {}) }, now);
}

/** Pastes clipboard items into `toDate` / `toMealGroupId` as new entries. */
export async function pasteItems(
  input: { items: readonly CopyItem[]; toDate: string; toMealGroupId: string | null },
  now?: number,
): Promise<CopyOutcome> {
  if (!isValidISODate(input.toDate)) throw new Error('Invalid date.');
  const userId = await requireUserId();
  return insertItems({ userId, toDate: input.toDate, items: input.items, mealGroupId: input.toMealGroupId }, now);
}

/**
 * Deletes entries of the signed-in user and returns what was deleted (complete rows, for Undo). Ids that do not exist
 * (or belong to somebody else) are ignored.
 */
export async function deleteEntries(ids: readonly string[]): Promise<DiarySnapshotRow[]> {
  const clean = Array.from(new Set(ids.filter((id) => isUuid(id))));
  if (clean.length === 0) return [];
  const userId = await requireUserId();
  const snapshot = await supabase.from('diary_entries').select(SNAPSHOT_SELECT).in('id', clean).eq('user_id', userId);
  if (snapshot.error) throw snapshot.error;
  const rows = ((snapshot.data ?? []) as unknown as DiarySnapshotRow[]).map((r) => ({ ...r, grams: Number(r.grams) }));
  if (rows.length === 0) return [];
  const { error } = await supabase
    .from('diary_entries')
    .delete()
    .in('id', rows.map((r) => r.id))
    .eq('user_id', userId);
  if (error) throw error;
  return rows;
}

/** Puts deleted entries back with their original values (and ids). Returns the restored ids. */
export async function restoreEntries(rows: readonly DiarySnapshotRow[]): Promise<string[]> {
  const userId = await requireUserId();
  const valid = buildRestoreRows(rows, userId);
  if (valid.length === 0) return [];
  const { data, error } = await supabase.from('diary_entries').insert(valid).select('id');
  if (error) throw error;
  return ((data ?? []) as { id: string }[]).map((r) => r.id);
}
