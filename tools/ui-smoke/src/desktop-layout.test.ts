/**
 * The rules behind the desktop page layouts (dashboard, diary, foods on a window of 900 px or more): how many columns of panels fit
 * a content width, how panels are dealt into rows, how a KPI strip wraps, the two panes of the diary, and the long date of the page
 * header. Pure Node: apps/app/src/components/desktop-layout.ts imports no React Native.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DIARY_LIST_MIN_WIDTH,
  DIARY_SPLIT_FROM,
  KPI_MIN_CELL_WIDTH,
  THREE_COLUMNS_FROM,
  TWO_COLUMNS_FROM,
  chunk,
  clampSpan,
  columnsFor,
  estimateContentWidth,
  formatLongDate,
  kpiColumns,
  packRows,
  planDiary,
  planGrid,
  textColumnWidth,
} from '../../../apps/app/src/components/desktop-layout';
import { DESKTOP_CONTENT_MAX_WIDTH, DESKTOP_CONTENT_PADDING, PANEL_GAP, SIDEBAR_WIDTH } from '../../../apps/app/src/theme/desktop';

const here = dirname(fileURLToPath(import.meta.url));

describe('columnsFor / planGrid', () => {
  it('one column below 760 px of content, two up to 1119, three from 1120', () => {
    expect(TWO_COLUMNS_FROM).toBe(760);
    expect(THREE_COLUMNS_FROM).toBe(1120);
    expect(columnsFor(0)).toBe(1);
    expect(columnsFor(612)).toBe(1); // a 900 px window: 900 - 248 sidebar - 40 padding
    expect(columnsFor(759)).toBe(1);
    expect(columnsFor(760)).toBe(2);
    expect(columnsFor(992)).toBe(2); // a 1280 px window
    expect(columnsFor(1119)).toBe(2);
    expect(columnsFor(1120)).toBe(3);
    expect(columnsFor(1152)).toBe(3); // a 1440 px window: columns of ~375 px
    expect(columnsFor(1400)).toBe(3); // a 1920 px window, content capped at 1440 - 40
    expect(columnsFor(Number.NaN)).toBe(1);
  });

  it('plans the gap (12) and the width of one column', () => {
    const plan = planGrid(992);
    expect(plan.columns).toBe(2);
    expect(plan.gap).toBe(PANEL_GAP);
    expect(plan.columnWidth).toBe((992 - 12) / 2);
    expect(planGrid(1152).columnWidth).toBe((1152 - 24) / 3);
    expect(planGrid(500)).toEqual({ columns: 1, gap: 12, columnWidth: 500 });
    expect(planGrid(-5).columnWidth).toBe(0);
  });

  it('a given column count overrides the plan and is kept between 1 and 3', () => {
    expect(planGrid(1400, { columns: 1 }).columns).toBe(1);
    expect(planGrid(400, { columns: 2 }).columns).toBe(2);
    expect(planGrid(400, { columns: 0 }).columns).toBe(1);
    expect(planGrid(400, { columns: 7 }).columns).toBe(3);
    expect(planGrid(400, { columns: 2.4 }).columns).toBe(2);
    expect(planGrid(1000, { gap: 20 }).gap).toBe(20);
  });
});

describe('clampSpan / packRows', () => {
  it('a span is a whole number of columns, at least 1 and at most the columns of the grid', () => {
    expect(clampSpan(undefined, 3)).toBe(1);
    expect(clampSpan(2, 3)).toBe(2);
    expect(clampSpan(5, 3)).toBe(3);
    expect(clampSpan(0, 3)).toBe(1);
    expect(clampSpan(1.6, 3)).toBe(2);
    expect(clampSpan(2, 1)).toBe(1);
    expect(clampSpan(Number.NaN, 3)).toBe(1);
  });

  it('deals panels into rows of at most `columns` columns, in order', () => {
    expect(packRows([1, 1, 1, 1, 1, 1], 3)).toEqual([
      [0, 1, 2],
      [3, 4, 5],
    ]);
    expect(packRows([1, 1, 1, 1, 1], 3)).toEqual([
      [0, 1, 2],
      [3, 4],
    ]);
    expect(packRows([undefined, undefined, undefined, undefined], 2)).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(packRows([1, 1, 1], 1)).toEqual([[0], [1], [2]]);
    expect(packRows([], 3)).toEqual([]);
  });

  it('a panel that does not fit in the rest of a row starts the next one; a span wider than the grid is cut to it', () => {
    expect(packRows([2, 1, 1], 3)).toEqual([[0, 1], [2]]);
    expect(packRows([1, 2, 2], 3)).toEqual([[0, 1], [2]]);
    expect(packRows([1, 1, 3], 3)).toEqual([[0, 1], [2]]);
    expect(packRows([9, 1], 2)).toEqual([[0], [1]]);
    expect(packRows([3], 2)).toEqual([[0]]);
  });

  it('never loses or repeats a panel', () => {
    for (const columns of [1, 2, 3]) {
      for (const spans of [[1, 1, 1, 1, 1, 1, 1], [3, 1, 2, 1, 1], [2, 2, 2, 2], [1]]) {
        const flat = packRows(spans, columns).flat();
        expect(flat).toEqual(spans.map((_, i) => i));
      }
    }
  });
});

describe('kpiColumns / chunk', () => {
  it('as many cells per row as fit, spread evenly over the rows they need', () => {
    expect(KPI_MIN_CELL_WIDTH).toBe(150);
    expect(kpiColumns(1000, 6)).toBe(6);
    expect(kpiColumns(900, 6)).toBe(6);
    expect(kpiColumns(612, 6)).toBe(3); // a 900 px window: 4 would fit, 3 + 3 beats 4 + 2
    expect(kpiColumns(500, 6)).toBe(3);
    expect(kpiColumns(300, 6)).toBe(2);
    expect(kpiColumns(140, 6)).toBe(1);
    expect(kpiColumns(700, 5)).toBe(3); // 3 + 2, not 4 + 1
    expect(kpiColumns(1000, 5)).toBe(5);
    expect(kpiColumns(700, 4)).toBe(4); // all four fit
    expect(kpiColumns(500, 4)).toBe(2); // 2 + 2, not 3 + 1
    expect(kpiColumns(600, 7)).toBe(4); // 4 + 3
    expect(kpiColumns(0, 5)).toBe(1);
    expect(kpiColumns(Number.NaN, 5)).toBe(1); // an unknown width: one column
  });

  it('a single cell is one column', () => {
    expect(kpiColumns(1000, 1)).toBe(1);
    expect(kpiColumns(1000, 0)).toBe(1);
  });

  it('never more cells per row than fit, never more than there are', () => {
    for (let width = 0; width <= 1600; width += 37) {
      for (let count = 1; count <= 8; count += 1) {
        const perRow = kpiColumns(width, count);
        expect(perRow).toBeGreaterThanOrEqual(1);
        expect(perRow).toBeLessThanOrEqual(count);
        expect(perRow).toBeLessThanOrEqual(Math.max(1, Math.floor(width / KPI_MIN_CELL_WIDTH)));
      }
    }
  });

  it('chunk splits into rows', () => {
    expect(chunk([1, 2, 3, 4, 5, 6], 3)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(chunk([1, 2, 3, 4, 5], 3)).toEqual([[1, 2, 3], [4, 5]]);
    expect(chunk([1, 2], 0)).toEqual([[1], [2]]);
    expect(chunk([], 3)).toEqual([]);
  });
});

describe('estimateContentWidth', () => {
  it('is the window without the sidebar and the page padding, capped at the widest content', () => {
    expect(estimateContentWidth(900)).toBe(900 - SIDEBAR_WIDTH - DESKTOP_CONTENT_PADDING * 2);
    expect(estimateContentWidth(1280)).toBe(992);
    expect(estimateContentWidth(1440)).toBe(1152);
    expect(estimateContentWidth(1920)).toBe(DESKTOP_CONTENT_MAX_WIDTH - DESKTOP_CONTENT_PADDING * 2);
    expect(estimateContentWidth(2560)).toBe(1400);
  });

  it('is never negative and survives a broken width', () => {
    expect(estimateContentWidth(100)).toBe(0);
    expect(estimateContentWidth(Number.NaN)).toBe(0);
  });

  it('the first guess already picks the columns the real width will: 900, 1280, 1440 and 1920 px windows', () => {
    expect(columnsFor(estimateContentWidth(900))).toBe(1);
    expect(columnsFor(estimateContentWidth(1280))).toBe(2);
    expect(columnsFor(estimateContentWidth(1440))).toBe(3);
    expect(columnsFor(estimateContentWidth(1920))).toBe(3);
  });
});

describe('planDiary', () => {
  it('stacks below 900 px of content', () => {
    expect(DIARY_SPLIT_FROM).toBe(900);
    expect(planDiary(612).split).toBe(false);
    expect(planDiary(899).split).toBe(false);
    expect(planDiary(612)).toMatchObject({ listWidth: 612, sideWidth: 612 });
  });

  it('two panes from 900 px: the list about 58 % but at least 520 px, the side the rest', () => {
    expect(DIARY_LIST_MIN_WIDTH).toBe(520);
    const narrow = planDiary(900);
    expect(narrow.split).toBe(true);
    expect(narrow.listWidth).toBe(520); // 58 % would be 515
    expect(narrow.sideWidth).toBe(900 - 12 - 520);
    const mid = planDiary(992); // a 1280 px window
    expect(mid.listWidth).toBe(568);
    expect(mid.sideWidth).toBe(412);
    const wide = planDiary(1400); // a 1920 px window
    expect(wide.listWidth).toBe(805);
    expect(wide.sideWidth).toBe(583);
  });

  it('the panes and the gap fill the width exactly, and the flex ratio is 58 : 42', () => {
    for (let width = 900; width <= 1600; width += 50) {
      const plan = planDiary(width);
      expect(plan.listWidth + PANEL_GAP + plan.sideWidth).toBe(width);
      expect(plan.listWidth).toBeGreaterThanOrEqual(DIARY_LIST_MIN_WIDTH);
      expect([plan.listFlex, plan.sideFlex]).toEqual([58, 42]);
    }
  });
});

describe('formatLongDate', () => {
  it('"Tuesday, November 10", the year only when it is not the current one', () => {
    expect(formatLongDate('2026-11-10', 2026)).toBe('Tuesday, November 10');
    expect(formatLongDate('2026-11-10')).toBe('Tuesday, November 10');
    expect(formatLongDate('2026-11-10', 2027)).toBe('Tuesday, November 10, 2026');
    expect(formatLongDate('2027-01-01', 2027)).toBe('Friday, January 1');
    expect(formatLongDate('2024-02-29', 2024)).toBe('Thursday, February 29');
  });

  it('a value that is not a date is returned as it is', () => {
    expect(formatLongDate('soon')).toBe('soon');
    expect(formatLongDate('')).toBe('');
  });
});

describe('textColumnWidth', () => {
  it('is as wide as the longest text, with a minimum', () => {
    expect(textColumnWidth([], 7)).toBe(0);
    expect(textColumnWidth(['ab', 'abcd', 'abc'], 7)).toBe(28);
    expect(textColumnWidth(['2,376 / 2,195 kcal'], 6.9)).toBe(Math.ceil(18 * 6.9));
    expect(textColumnWidth(['1%'], 7, 32)).toBe(32);
    expect(textColumnWidth([''], 7)).toBe(0);
  });
});

describe('the building blocks stay inside the rules of the app', () => {
  it('desktop-layout.ts is pure: it imports no React Native', () => {
    const source = readFileSync(join(here, '..', '..', '..', 'apps', 'app', 'src', 'components', 'desktop-layout.ts'), 'utf8');
    expect(source).not.toMatch(/from\s+['"]react-native/);
    expect(source).not.toMatch(/from\s+['"]react['"]/);
  });
});
