// Pure (no React Native imports): the rules behind the desktop page layouts (the dashboard, the diary and the foods screen on a
// window of WIDE_BREAKPOINT or more). They live apart from components/panel.tsx so tools/ui-smoke can unit test them in plain Node.
//
// Everything here works on the width of the CONTENT (the area to the right of the sidebar, inside the page padding), not on the
// window, so the plans stay right whatever the sidebar takes.
// A relative path (not `@/`), so tools/ui-smoke can import this file statically and still typecheck.
import { DESKTOP_CONTENT_MAX_WIDTH, DESKTOP_CONTENT_PADDING, PANEL_GAP, SIDEBAR_WIDTH } from '../theme/desktop';

// ------------------------------------------------------------------------------------------------ the panel grid

/** From this content width (px) a grid of panels has two columns; below it, one. */
export const TWO_COLUMNS_FROM = 760;

/** From this content width (px) a grid of panels has three columns. (A 1440 px window leaves about 1150 px: three columns of ~375.) */
export const THREE_COLUMNS_FROM = 1120;

export type ColumnCount = 1 | 2 | 3;

/** How many columns of panels fit in a content `width`: 1 below 760, 2 up to 1119, 3 from 1120. */
export function columnsFor(width: number): ColumnCount {
  if (!Number.isFinite(width) || width < TWO_COLUMNS_FROM) return 1;
  return width < THREE_COLUMNS_FROM ? 2 : 3;
}

export interface GridPlan {
  columns: ColumnCount;
  gap: number;
  /** Width of one column (px, may be fractional). */
  columnWidth: number;
}

/**
 * The column plan for a content `width`. `columns` overrides the planned count (a narrow side column that wants one column
 * whatever its width); it is clamped to 1..3. The gap is PANEL_GAP unless given.
 */
export function planGrid(width: number, options: { columns?: number; gap?: number } = {}): GridPlan {
  const gap = options.gap ?? PANEL_GAP;
  const wanted = options.columns === undefined ? columnsFor(width) : Math.min(3, Math.max(1, Math.round(options.columns)));
  const columns = wanted as ColumnCount;
  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  return { columns, gap, columnWidth: (safeWidth - gap * (columns - 1)) / columns };
}

/** The span of a panel, as the grid reads it: a whole number of columns, at least 1 and at most `columns`. */
export function clampSpan(span: number | undefined, columns: number): number {
  const n = span === undefined || !Number.isFinite(span) ? 1 : Math.round(span);
  return Math.min(Math.max(1, columns), Math.max(1, n));
}

/**
 * Deals panels (by their spans) into rows of at most `columns` columns, in order, and returns the indices of each row. A panel
 * that does not fit in the rest of a row starts the next one. The grid gives every panel of a row `flex: span`, so a row that is
 * not full (the last one) still fills the width: no half-empty rows.
 */
export function packRows(spans: readonly (number | undefined)[], columns: number): number[][] {
  const rows: number[][] = [];
  let current: number[] = [];
  let used = 0;
  spans.forEach((raw, index) => {
    const span = clampSpan(raw, columns);
    if (used + span > columns && current.length > 0) {
      rows.push(current);
      current = [];
      used = 0;
    }
    current.push(index);
    used += span;
  });
  if (current.length > 0) rows.push(current);
  return rows;
}

// ------------------------------------------------------------------------------------------------ the KPI strip

/** The narrowest a KPI cell is allowed to get (px) before the strip wraps onto a second row. */
export const KPI_MIN_CELL_WIDTH = 150;

/**
 * How many KPI cells go on one row of a strip that is `width` wide. As many as fit (at least KPI_MIN_CELL_WIDTH each) decide the
 * number of rows; the cells are then spread evenly over those rows, so six cells become 3 + 3 and not 4 + 2 when four would fit,
 * and five become 3 + 2.
 */
export function kpiColumns(width: number, count: number, minCellWidth = KPI_MIN_CELL_WIDTH): number {
  if (count <= 1) return 1;
  const fit = Number.isFinite(width) ? Math.floor(width / minCellWidth) : 1;
  const widest = Math.min(count, Math.max(1, fit));
  const rows = Math.ceil(count / widest);
  return Math.ceil(count / rows);
}

/** Splits `items` into rows of `perRow`. */
export function chunk<T>(items: readonly T[], perRow: number): T[][] {
  const size = Math.max(1, Math.floor(perRow));
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

// ------------------------------------------------------------------------------------------------ the page

/**
 * A first guess of the content width from the window width (the sidebar and the page padding taken off, capped at the widest the
 * content grows), used until the real width is measured so the first frame is not a one-column flash.
 */
export function estimateContentWidth(windowWidth: number): number {
  if (!Number.isFinite(windowWidth)) return 0;
  const inner = windowWidth - SIDEBAR_WIDTH - DESKTOP_CONTENT_PADDING * 2;
  return Math.min(Math.max(0, inner), DESKTOP_CONTENT_MAX_WIDTH - DESKTOP_CONTENT_PADDING * 2);
}

/** The diary is two panes (entries at the left, targets at the right) from this content width. */
export const DIARY_SPLIT_FROM = 900;
/** The entry list never gets narrower than this in the split diary. */
export const DIARY_LIST_MIN_WIDTH = 520;
/** The share of the width the entry list takes in the split diary. */
export const DIARY_LIST_SHARE = 0.58;

export interface DiaryPlan {
  split: boolean;
  /** Width of the entry list pane (px); the full width when stacked. */
  listWidth: number;
  /** Width of the side pane (px); the full width when stacked. */
  sideWidth: number;
  /** `flex` of the two panes (58 : 42). */
  listFlex: number;
  sideFlex: number;
}

/** Two panes from DIARY_SPLIT_FROM (list 58 %, at least 520 px; side the rest), one stacked column below. */
export function planDiary(width: number, gap: number = PANEL_GAP): DiaryPlan {
  const safe = Number.isFinite(width) ? Math.max(0, width) : 0;
  const listFlex = Math.round(DIARY_LIST_SHARE * 100);
  const sideFlex = 100 - listFlex;
  if (safe < DIARY_SPLIT_FROM) return { split: false, listWidth: safe, sideWidth: safe, listFlex, sideFlex };
  const listWidth = Math.max(DIARY_LIST_MIN_WIDTH, Math.round((safe - gap) * DIARY_LIST_SHARE));
  return { split: true, listWidth, sideWidth: safe - gap - listWidth, listFlex, sideFlex };
}

// ------------------------------------------------------------------------------------------------ dates

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTHS = [
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

/** "Tuesday, November 10" (", 2027" is added when the year is not `currentYear`). Locale independent. */
export function formatLongDate(iso: string, currentYear?: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(y, m - 1, d, 12);
  const base = `${WEEKDAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return currentYear === undefined || currentYear === y ? base : `${base}, ${y}`;
}

// ------------------------------------------------------------------------------------------------ bar lists

export type BarTone = 'muted' | 'success' | 'danger';

/** One row of a bar list: label, bar, value and percentage in aligned columns. Plain data; components/panel.tsx draws it. */
export interface BarRow {
  key: string;
  label: string;
  /** "2,376 / 2,195 kcal". */
  valueText: string;
  /** "108%", empty when unknown. */
  pctText: string;
  tone: BarTone;
  color: string;
  /** Overflow colour (past the target). */
  overColor: string;
  /** Filled share of the track (0..1). */
  fill: number;
  /** Share of the track filled past the target (0..1). */
  overFill: number;
  /** Where the target sits on the track (0..1) when the bar is past it. */
  markAt: number | undefined;
  accessibilityLabel: string;
  /** 0..100 for the progress bar accessibility value. */
  now: number | undefined;
}

/** Approximate width (px) of the widest of `texts` at a font that is `charWidth` px per character: a fixed column that keeps bars aligned. */
export function textColumnWidth(texts: readonly string[], charWidth: number, min = 0): number {
  const longest = texts.reduce((n, t) => Math.max(n, t.length), 0);
  return Math.max(min, Math.ceil(longest * charWidth));
}
