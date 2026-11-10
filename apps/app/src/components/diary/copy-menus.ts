// Which actions the diary menus offer, as plain data. Pure (no React / no data fetching) so the rules are unit tested
// in tools/ui-smoke; diary.tsx and EntryActionSheet.tsx attach the handlers.
import { pasteLabel, type DiaryClipboard } from '@/data/diary-copy';

export interface MenuItemSpec<K extends string> {
  key: K;
  label: string;
  destructive?: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Meal group header "..." menu
// ---------------------------------------------------------------------------------------------------------------

export type GroupMenuKey =
  | 'add'
  | 'copy-yesterday'
  | 'copy-to-today'
  | 'copy-group'
  | 'paste'
  | 'copy-from-day'
  | 'create-recipe'
  | 'create-meal'
  | 'nutrition-summary'
  | 'sort-time'
  | 'collapse'
  | 'delete';

export interface GroupMenuInput {
  name: string;
  /** A real meal group (false for the "Other" bucket of entries without a valid group). */
  hasGroup: boolean;
  entryCount: number;
  /** Entries of the same meal group on the day before the viewed one. */
  yesterdayCount: number;
  /** The viewed date is before today. */
  isPastDate: boolean;
  clipboard: Pick<DiaryClipboard, 'kind'> | null;
  collapsed: boolean;
  /** The entries are currently shown newest first. */
  newestFirst: boolean;
}

export function groupMenuItems(input: GroupMenuInput): MenuItemSpec<GroupMenuKey>[] {
  const { name, hasGroup, entryCount } = input;
  const has = entryCount > 0;
  const items: MenuItemSpec<GroupMenuKey>[] = [];
  if (hasGroup) items.push({ key: 'add', label: `Add food to ${name}` });
  if (hasGroup && input.yesterdayCount > 0) items.push({ key: 'copy-yesterday', label: "Copy Yesterday's Group" });
  if (hasGroup && input.isPastDate && has) items.push({ key: 'copy-to-today', label: 'Copy to Today' });
  if (has) items.push({ key: 'copy-group', label: 'Copy Group' });
  if (hasGroup && input.clipboard) items.push({ key: 'paste', label: pasteLabel(input.clipboard) });
  if (hasGroup) items.push({ key: 'copy-from-day', label: `Copy ${name} from another day...` });
  if (has) {
    items.push({ key: 'create-recipe', label: 'Create Recipe from Group' });
    items.push({ key: 'create-meal', label: 'Create Meal from Group' });
    items.push({ key: 'nutrition-summary', label: 'Show Nutrition Summary' });
  }
  // Entries are listed in the order they were logged; this flips that order for the group (view only).
  if (entryCount > 1) {
    items.push({ key: 'sort-time', label: `Sort by Time: ${input.newestFirst ? 'oldest first' : 'newest first'}` });
  }
  items.push({ key: 'collapse', label: input.collapsed ? `Expand ${name}` : `Collapse ${name}` });
  if (has) items.push({ key: 'delete', label: 'Delete group entries', destructive: true });
  return items;
}

// ---------------------------------------------------------------------------------------------------------------
// Date bar "..." menu
// ---------------------------------------------------------------------------------------------------------------

export type DateMenuKey = 'today' | 'copy-yesterday-diary' | 'copy-day' | 'toggle-all';

export interface DateMenuInput {
  isToday: boolean;
  /** Entries on the day before the viewed one. */
  yesterdayCount: number;
  sectionCount: number;
  allCollapsed: boolean;
}

export function dateMenuItems(input: DateMenuInput): MenuItemSpec<DateMenuKey>[] {
  const items: MenuItemSpec<DateMenuKey>[] = [];
  if (!input.isToday) items.push({ key: 'today', label: 'Go to today' });
  if (input.yesterdayCount > 0) items.push({ key: 'copy-yesterday-diary', label: "Copy yesterday's entire diary" });
  items.push({ key: 'copy-day', label: 'Copy a day from...' });
  items.push({ key: 'toggle-all', label: input.allCollapsed ? 'Expand all meals' : 'Collapse all meals' });
  return items;
}

// ---------------------------------------------------------------------------------------------------------------
// Entry action sheet
// ---------------------------------------------------------------------------------------------------------------

export interface EntryCopyActions {
  copy: string;
  /** null = nothing on the clipboard. */
  paste: string | null;
  /** null = the viewed date is not in the past. */
  copyToToday: string | null;
}

export function entryCopyActions(input: {
  isPastDate: boolean;
  clipboard: Pick<DiaryClipboard, 'kind'> | null;
}): EntryCopyActions {
  return {
    copy: 'Copy Entry',
    paste: input.clipboard ? pasteLabel(input.clipboard) : null,
    copyToToday: input.isPastDate ? 'Copy to Today' : null,
  };
}
