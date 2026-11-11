/**
 * The desktop shell, pure parts (apps/app/src/components/desktop/*): what the sidebar lists and which row is lit for a path, where the
 * shell is drawn and how a sidebar click navigates, the month grid of the calendar, the collapse state and its saved form, and the
 * texts of the status bar. Pure Node: the components themselves (hover, scrolling, the real navigation) are covered by the browser
 * smoke scenarios `shell: ...` in scenarios.ts.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  WEEKDAY_INITIALS,
  WEEKS_SHOWN,
  buildMonthGrid,
  dayLabel,
  leadingDays,
  monthOf,
  monthTitle,
  parseIsoDate,
  sameMonth,
  shiftMonth,
} from '../../../apps/app/src/components/desktop/month-grid';
import {
  SHELL_EXCLUDED_PATHS,
  breadcrumbParent,
  isShellExcludedPath,
  isTabPath,
  shouldShowDesktopShell,
  sidebarNavigation,
} from '../../../apps/app/src/components/desktop/shell-routes';
import {
  DASHBOARD_ROW,
  DIARY_ROW,
  FOODS_ROW,
  TAB_ROWS,
  buildSidebarGroups,
  normalizePath,
  resolveActiveRowId,
  rowAccessibleName,
  type SidebarGroup,
} from '../../../apps/app/src/components/desktop/sidebar-model';
import {
  COLLAPSED_BY_DEFAULT,
  DEFAULT_SIDEBAR_STATE,
  SIDEBAR_SECTION_IDS,
  SIDEBAR_STORAGE_KEY,
  isSectionCollapsed,
  parseSidebarState,
  sanitizeSidebarState,
  serializeSidebarState,
  setSectionCollapsed,
  toggleSection,
} from '../../../apps/app/src/components/desktop/sidebar-state';
import {
  NOT_SYNCED_TEXT,
  SYNCING_TEXT,
  aiStatusText,
  buildStatusRight,
  formatSyncStatus,
  newestDate,
  versionText,
} from '../../../apps/app/src/components/desktop/status-text';
import { buildMoreSections } from '../../../apps/app/src/components/settings/more-sections';
import { DESKTOP_CONTENT_PADDING, PAGE_HEADER_HEIGHT, SIDEBAR_WIDTH, STATUS_BAR_HEIGHT } from '../../../apps/app/src/theme/desktop';
import { scanRoutes } from './routes-scan';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'apps', 'app', 'src', 'app');

const groupsOf = (aiEnabled: boolean): SidebarGroup[] => buildSidebarGroups({ aiEnabled });
const allRows = (aiEnabled: boolean) => groupsOf(aiEnabled).flatMap((g) => g.rows);

// ---------------------------------------------------------------------------------------------------------------------------
// The sidebar model
// ---------------------------------------------------------------------------------------------------------------------------

describe('sidebar groups', () => {
  it.each([true, false])('lists Daily, Training, Coach, Profile, Connections, App in this order (AI enabled: %s)', (aiEnabled) => {
    expect(groupsOf(aiEnabled).map((g) => g.label)).toEqual(['Daily', 'Training', 'Coach', 'Profile', 'Connections', 'App']);
    expect(groupsOf(aiEnabled).map((g) => g.id)).toEqual(['daily', 'training', 'coach', 'profile', 'connections', 'app']);
  });

  it('puts the rows in their groups, in order', () => {
    const rows = (aiEnabled: boolean) => Object.fromEntries(groupsOf(aiEnabled).map((g) => [g.id, g.rows.map((r) => r.label)]));
    expect(rows(true)).toEqual({
      daily: ['Dashboard', 'Diary', 'Foods'],
      training: ['Workouts'],
      coach: ['Coach', 'AI Coach & keys'],
      profile: ['Profile & targets', 'Personal details', 'Nutrient targets', 'Friends'],
      connections: ['Connected apps & devices'],
      app: ['Display & units', 'About'],
    });
    expect(rows(false)).toEqual({ ...rows(true), coach: ['AI (optional)'] });
  });

  it('has no More row on a desktop and no Account group (the account is the footer)', () => {
    for (const aiEnabled of [true, false]) {
      expect(allRows(aiEnabled).map((r) => r.label)).not.toContain('More');
      expect(groupsOf(aiEnabled).map((g) => g.label)).not.toContain('Account');
      expect(allRows(aiEnabled).map((r) => r.href)).not.toContain('/more');
    }
  });

  it('carries every row of the More screen, with the same label, route and icon (they are defined once)', () => {
    for (const aiEnabled of [true, false]) {
      const sidebar = allRows(aiEnabled);
      for (const more of buildMoreSections({ aiEnabled }).flatMap((s) => s.rows)) {
        const row = sidebar.find((r) => r.id === more.id);
        expect(row, `${more.label} is in the sidebar`).toBeDefined();
        expect(row).toMatchObject({ label: more.label, href: more.href, symbol: more.symbol, ...(more.badge ? { badge: more.badge } : {}) });
      }
    }
  });

  it('says whether AI is on on the AI row, and shows the Coach row only with AI', () => {
    expect(allRows(true).find((r) => r.id === 'ai')).toMatchObject({ label: 'AI Coach & keys', badge: 'On', href: '/settings/ai' });
    expect(allRows(false).find((r) => r.id === 'ai')).toMatchObject({ label: 'AI (optional)', badge: 'Off', href: '/settings/ai' });
    expect(allRows(true).map((r) => r.id)).toContain('coach');
    expect(allRows(false).map((r) => r.id)).not.toContain('coach');
  });

  it('has no status text except on the AI row (nothing that would need a query)', () => {
    for (const aiEnabled of [true, false]) {
      expect(allRows(aiEnabled).filter((r) => r.badge !== undefined).map((r) => r.id)).toEqual(['ai']);
    }
  });

  it('has no duplicate row ids, labels or routes, and no row labelled like a group except Coach', () => {
    for (const aiEnabled of [true, false]) {
      const rows = allRows(aiEnabled);
      expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
      expect(new Set(rows.map((r) => r.label)).size).toBe(rows.length);
      expect(new Set(rows.map((r) => r.href)).size).toBe(rows.length);
      const groupLabels = groupsOf(aiEnabled).map((g) => g.label);
      expect(rows.filter((r) => groupLabels.includes(r.label)).map((r) => r.label)).toEqual(aiEnabled ? ['Coach'] : []);
    }
  });

  it('leads every row to a screen that exists, and gives every row an icon for iOS, Android and the web', () => {
    const routes = new Set(scanRoutes(APP_DIR).map((r) => r.pattern));
    for (const row of allRows(true)) {
      expect(routes.has(row.href), `${row.label} -> ${row.href}`).toBe(true);
      for (const platform of ['ios', 'android', 'web'] as const) expect(row.symbol[platform], `${row.label} ${platform}`).toMatch(/^[a-z0-9_.]+$/);
    }
  });

  it('shares the tab icons with the phone bar: Daily is exactly the three tab rows', () => {
    expect(TAB_ROWS).toEqual([DASHBOARD_ROW, DIARY_ROW, FOODS_ROW]);
    expect(groupsOf(true)[0]?.rows.map((r) => r.href)).toEqual(['/', '/diary', '/foods']);
  });

  it('names a row by its label, and the AI row also by its status like the More row does', () => {
    expect(rowAccessibleName({ label: 'Diary' })).toBe('Diary');
    expect(rowAccessibleName({ label: 'AI (optional)', badge: 'Off' })).toBe('AI (optional). Off');
    expect(rowAccessibleName({ label: 'AI Coach & keys', badge: 'On' })).toBe('AI Coach & keys. On');
  });
});

describe('active row', () => {
  const active = (path: string, aiEnabled = true) => resolveActiveRowId(groupsOf(aiEnabled), path);

  it.each([
    ['/', 'dashboard'],
    ['/diary', 'diary'],
    ['/foods', 'foods'],
    ['/workouts', 'workouts'],
    ['/workouts/4d6d9a1c-0000-4000-8000-000000000001', 'workouts'],
    ['/workouts/[id]', 'workouts'],
    ['/coach', 'coach'],
    ['/coach/history', 'coach'],
    ['/coach/5b1f', 'coach'],
    ['/settings/targets', 'targets'],
    ['/settings/profile', 'profile'],
    ['/settings/nutrients', 'nutrients'],
    ['/settings/integrations', 'integrations'],
    ['/settings/garmin-sign-in', 'integrations'],
    ['/settings/display', 'display'],
    ['/settings/about', 'about'],
    ['/settings/ai', 'ai'],
    ['/food/70d7298e', 'foods'],
    ['/food/new', 'foods'],
    ['/food/edit/70d7298e', 'foods'],
    ['/recipe/new', 'foods'],
    ['/recipe/edit/9c', 'foods'],
    ['/saved-meal/new', 'foods'],
  ])('%s lights %s', (path, id) => {
    expect(active(path)).toBe(id);
  });

  it('lights nothing for the add flows, which belong to no page, and for pages the sidebar does not list', () => {
    for (const path of ['/add', '/search', '/scan', '/ai/photo', '/ai/recipe', '/exercise/new', '/biometric/new', '/note/new', '/water/new', '/onboarding', '/sign-in', '/more', '/nowhere']) {
      expect(active(path), path).toBeNull();
    }
  });

  it('does not light Foods for /foodstuff and does not light Workouts for /workoutsx (prefixes end at a segment)', () => {
    expect(active('/foodstuff')).toBeNull();
    expect(active('/workoutsx')).toBeNull();
    expect(active('/food')).toBe('foods');
  });

  it('ignores a query string, a hash and a trailing slash', () => {
    expect(active('/diary?date=2026-11-09')).toBe('diary');
    expect(active('/diary/')).toBe('diary');
    expect(active('/settings/display#top')).toBe('display');
    expect(active('')).toBe('dashboard');
    expect(active('/?x=1')).toBe('dashboard');
  });

  it('lights nothing for /coach without AI (there is no Coach row), but still finds the AI row', () => {
    expect(active('/coach', false)).toBeNull();
    expect(active('/settings/ai', false)).toBe('ai');
  });

  it('picks the most specific row and lights at most one', () => {
    const rows = allRows(true);
    for (const row of rows) expect(active(row.href), row.href).toBe(row.id);
  });

  it('normalises paths', () => {
    expect(normalizePath('/diary/?a=1#b')).toBe('/diary');
    expect(normalizePath('diary')).toBe('/diary');
    expect(normalizePath('///')).toBe('/');
    expect(normalizePath('')).toBe('/');
    expect(normalizePath('/settings/ai')).toBe('/settings/ai');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Where the shell is drawn, and how a click navigates
// ---------------------------------------------------------------------------------------------------------------------------

describe('desktop shell routes', () => {
  const show = (over: Partial<Parameters<typeof shouldShowDesktopShell>[0]> = {}) =>
    shouldShowDesktopShell({ wide: true, signedIn: true, onboarded: true, pathname: '/', ...over });

  it('is drawn for a signed-in, onboarded user in a wide window on every ordinary screen', () => {
    for (const path of ['/', '/diary', '/foods', '/workouts', '/workouts/abc', '/coach', '/settings/display', '/settings/targets', '/food/abc', '/recipe/abc', '/search', '/add', '/exercise/new']) {
      expect(show({ pathname: path }), path).toBe(true);
    }
  });

  it('is never drawn on a phone, signed out, before onboarding is finished, or on the full-screen routes', () => {
    expect(show({ wide: false })).toBe(false);
    expect(show({ signedIn: false })).toBe(false);
    expect(show({ onboarded: false })).toBe(false);
    for (const path of ['/sign-in', '/onboarding', '/scan', '/scan/', '/scan?x=1']) expect(show({ pathname: path }), path).toBe(false);
  });

  it('excludes exactly sign-in, onboarding and the camera, and those routes exist', () => {
    expect([...SHELL_EXCLUDED_PATHS]).toEqual(['/sign-in', '/onboarding', '/scan']);
    const routes = new Set(scanRoutes(APP_DIR).map((r) => r.pattern));
    for (const path of SHELL_EXCLUDED_PATHS) expect(routes.has(path), path).toBe(true);
    // A route that merely contains the word is not excluded.
    expect(isShellExcludedPath('/settings/garmin-sign-in')).toBe(false);
    expect(isShellExcludedPath('/scanner')).toBe(false);
  });

  it('knows the tab pages', () => {
    for (const path of ['/', '/diary', '/foods', '/more', '/diary/']) expect(isTabPath(path), path).toBe(true);
    for (const path of ['/workouts', '/settings/display', '/food/abc', '/add']) expect(isTabPath(path), path).toBe(false);
  });
});

describe('sidebar navigation', () => {
  it('does nothing for the page that is open', () => {
    expect(sidebarNavigation('/diary', '/diary')).toBe('none');
    expect(sidebarNavigation('/', '/')).toBe('none');
    expect(sidebarNavigation('/workouts/', '/workouts')).toBe('none');
  });

  it('switches between tab pages with navigate', () => {
    expect(sidebarNavigation('/', '/diary')).toBe('navigate');
    expect(sidebarNavigation('/foods', '/')).toBe('navigate');
  });

  it('goes back to a tab from a page that is not a tab with dismissTo (never a second copy of the tabs)', () => {
    expect(sidebarNavigation('/workouts', '/')).toBe('dismissTo');
    expect(sidebarNavigation('/settings/display', '/foods')).toBe('dismissTo');
    expect(sidebarNavigation('/settings/about', '/')).toBe('dismissTo');
    expect(sidebarNavigation('/add', '/diary')).toBe('dismissTo');
  });

  it('opens a page from a tab with navigate, and swaps one stack page for another with replace', () => {
    expect(sidebarNavigation('/', '/workouts')).toBe('navigate');
    expect(sidebarNavigation('/foods', '/settings/display')).toBe('navigate');
    expect(sidebarNavigation('/workouts', '/settings/display')).toBe('replace');
    expect(sidebarNavigation('/workouts/abc', '/workouts')).toBe('replace');
    expect(sidebarNavigation('/add', '/workouts')).toBe('replace');
  });
});

describe('breadcrumb parent of the slim page header', () => {
  it.each([
    ['/settings/display', 'Settings'],
    ['/settings/targets', 'Settings'],
    ['/workouts/[id]', 'Workouts'],
    ['/workouts/4d6d', 'Workouts'],
    ['/coach/history', 'Coach'],
    ['/food/[id]', 'Foods'],
    ['/food/edit/[id]', 'Foods'],
    ['/recipe/new', 'Foods'],
    ['/saved-meal/[id]', 'Foods'],
  ])('%s is under %s', (path, parent) => {
    expect(breadcrumbParent(path)).toBe(parent);
  });

  it.each(['/workouts', '/workouts/index', '/coach', '/search', '/add', '/scan', '/ai/photo', '/exercise/new', '/'])('%s has no parent', (path) => {
    expect(breadcrumbParent(path)).toBeNull();
  });
});

describe('desktop measurements', () => {
  it('are the ones the page layouts share', () => {
    expect([SIDEBAR_WIDTH, PAGE_HEADER_HEIGHT, STATUS_BAR_HEIGHT, DESKTOP_CONTENT_PADDING]).toEqual([248, 44, 26, 20]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// The calendar
// ---------------------------------------------------------------------------------------------------------------------------

describe('month grid', () => {
  const TODAY = '2026-11-10';
  const flat = (year: number, month: number, marks = { today: TODAY, selected: TODAY }) => buildMonthGrid({ year, month }, marks).flat();

  it('is six weeks of seven days, Monday first (November 2026 starts on a Sunday)', () => {
    const weeks = buildMonthGrid({ year: 2026, month: 11 }, { today: TODAY, selected: '2026-11-04' });
    expect(weeks).toHaveLength(WEEKS_SHOWN);
    for (const week of weeks) expect(week).toHaveLength(7);
    expect(WEEKDAY_INITIALS).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
    expect(leadingDays({ year: 2026, month: 11 })).toBe(6);
    expect(weeks[0]?.map((c) => c.iso)).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
    expect(weeks[0]?.map((c) => c.inMonth)).toEqual([false, false, false, false, false, false, true]);
    expect(weeks[5]?.map((c) => c.iso)).toEqual(['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05', '2026-12-06']);
    expect(weeks[5]?.map((c) => c.inMonth)).toEqual([true, false, false, false, false, false, false]);
    expect(weeks[4]?.[0]?.iso).toBe('2026-11-23');
  });

  it('starts on the first when the month starts on a Monday (February 2027) and has no days of its own after the 28th', () => {
    expect(leadingDays({ year: 2027, month: 2 })).toBe(0);
    const cells = flat(2027, 2);
    expect(cells[0]?.iso).toBe('2027-02-01');
    expect(cells.filter((c) => c.inMonth)).toHaveLength(28);
    expect(cells.filter((c) => c.inMonth).at(-1)?.iso).toBe('2027-02-28');
  });

  it('knows leap years, month lengths and year ends', () => {
    expect(flat(2028, 2).filter((c) => c.inMonth)).toHaveLength(29);
    expect(flat(2026, 12).filter((c) => c.inMonth)).toHaveLength(31);
    expect(flat(2027, 1)[0]?.iso).toBe('2026-12-28'); // the Monday before Friday 1 January 2027
    expect(flat(2026, 4).filter((c) => c.inMonth)).toHaveLength(30);
  });

  it('is a run of consecutive calendar days, whatever the daylight-saving changes (March and October/November, many years)', () => {
    for (const [year, month] of [[2026, 3], [2026, 10], [2026, 11], [2027, 3], [2024, 4], [2028, 10]] as const) {
      const cells = flat(year, month);
      expect(cells).toHaveLength(42);
      for (let i = 1; i < cells.length; i++) {
        const [py, pm, pd] = (cells[i - 1]?.iso ?? '').split('-').map(Number) as [number, number, number];
        const [y, m, d] = (cells[i]?.iso ?? '').split('-').map(Number) as [number, number, number];
        expect(Date.UTC(y, m - 1, d) - Date.UTC(py, pm - 1, pd), `${year}-${month} cell ${i}`).toBe(86_400_000);
      }
    }
  });

  it('marks today and the selected date, each once, and only when they are on the grid', () => {
    const cells = flat(2026, 11, { today: TODAY, selected: '2026-11-04' });
    expect(cells.filter((c) => c.isToday).map((c) => c.iso)).toEqual([TODAY]);
    expect(cells.filter((c) => c.isSelected).map((c) => c.iso)).toEqual(['2026-11-04']);
    const same = flat(2026, 11);
    expect(same.filter((c) => c.isToday && c.isSelected).map((c) => c.iso)).toEqual([TODAY]);
    const other = flat(2027, 6);
    expect(other.some((c) => c.isToday || c.isSelected)).toBe(false);
    // A day of the neighbouring month on the grid is marked too (and dimmed through inMonth)
    const edge = flat(2026, 11, { today: TODAY, selected: '2026-10-28' }).find((c) => c.isSelected);
    expect(edge).toMatchObject({ iso: '2026-10-28', inMonth: false, day: 28 });
  });

  it('pages from month to month across year ends', () => {
    expect(shiftMonth({ year: 2026, month: 11 }, 1)).toEqual({ year: 2026, month: 12 });
    expect(shiftMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth({ year: 2026, month: 3 }, -15)).toEqual({ year: 2024, month: 12 });
    expect(shiftMonth({ year: 2026, month: 3 }, 0)).toEqual({ year: 2026, month: 3 });
    expect(shiftMonth({ year: 2026, month: 3 }, 24)).toEqual({ year: 2028, month: 3 });
  });

  it('titles and names', () => {
    expect(monthTitle({ year: 2026, month: 11 })).toBe('November 2026');
    expect(monthTitle({ year: 2027, month: 1 })).toBe('January 2027');
    expect(dayLabel('2026-11-09')).toBe('9 November 2026');
    expect(dayLabel('2026-01-01')).toBe('1 January 2026');
    expect(dayLabel('garbage')).toBe('garbage');
  });

  it('reads the month of a date, with a fallback for anything that is not one', () => {
    const fallback = { year: 2026, month: 11 };
    expect(monthOf('2026-03-15', fallback)).toEqual({ year: 2026, month: 3 });
    expect(monthOf('2026-02-31', fallback)).toEqual(fallback);
    expect(monthOf('', fallback)).toEqual(fallback);
    expect(monthOf('11/10/2026', fallback)).toEqual(fallback);
    expect(sameMonth({ year: 2026, month: 3 }, { year: 2026, month: 3 })).toBe(true);
    expect(sameMonth({ year: 2026, month: 3 }, { year: 2025, month: 3 })).toBe(false);
    expect(parseIsoDate('2028-02-29')).toEqual({ year: 2028, month: 2, day: 29 });
    expect(parseIsoDate('2027-02-29')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Collapse state
// ---------------------------------------------------------------------------------------------------------------------------

describe('sidebar collapse state', () => {
  it('starts with every group open and the calendar closed', () => {
    for (const id of SIDEBAR_SECTION_IDS) expect(isSectionCollapsed(DEFAULT_SIDEBAR_STATE, id), id).toBe(id === 'calendar');
    expect(COLLAPSED_BY_DEFAULT.calendar).toBe(true);
    expect([...SIDEBAR_SECTION_IDS]).toEqual(['daily', 'training', 'coach', 'profile', 'connections', 'app', 'admin', 'calendar']);
  });

  it('has a collapsible section for every group of the sidebar, plus the calendar', () => {
    const ids = new Set<string>(SIDEBAR_SECTION_IDS);
    for (const group of groupsOf(true)) expect(ids.has(group.id), group.id).toBe(true);
  });

  it('toggles one group without touching the others', () => {
    const closed = toggleSection(DEFAULT_SIDEBAR_STATE, 'training');
    expect(isSectionCollapsed(closed, 'training')).toBe(true);
    expect(isSectionCollapsed(closed, 'daily')).toBe(false);
    expect(isSectionCollapsed(toggleSection(closed, 'training'), 'training')).toBe(false);
    const calendar = toggleSection(DEFAULT_SIDEBAR_STATE, 'calendar');
    expect(isSectionCollapsed(calendar, 'calendar')).toBe(false);
    expect(isSectionCollapsed(toggleSection(calendar, 'calendar'), 'calendar')).toBe(true);
    expect(isSectionCollapsed(setSectionCollapsed(DEFAULT_SIDEBAR_STATE, 'app', true), 'app')).toBe(true);
  });

  it('does not change the state it is given', () => {
    const before = JSON.stringify(DEFAULT_SIDEBAR_STATE);
    toggleSection(DEFAULT_SIDEBAR_STATE, 'daily');
    setSectionCollapsed(DEFAULT_SIDEBAR_STATE, 'daily', true);
    expect(JSON.stringify(DEFAULT_SIDEBAR_STATE)).toBe(before);
  });

  it('saves and reads back what the user chose', () => {
    let state = toggleSection(DEFAULT_SIDEBAR_STATE, 'coach');
    state = toggleSection(state, 'calendar');
    const text = serializeSidebarState(state);
    expect(JSON.parse(text)).toEqual({ v: 1, collapsed: { coach: true, calendar: false } });
    expect(parseSidebarState(text)).toEqual(state);
    expect(isSectionCollapsed(parseSidebarState(text), 'coach')).toBe(true);
    expect(isSectionCollapsed(parseSidebarState(text), 'calendar')).toBe(false);
  });

  it('uses a versioned key', () => {
    expect(SIDEBAR_STORAGE_KEY).toBe('ration.sidebar.v1');
  });

  it('tolerates nothing, garbage and payloads of other shapes: the defaults come back', () => {
    for (const stored of [null, undefined, '', 'not json', '{', '[]', 'null', '42', '"daily"', 'true', '{}', '{"collapsed":null}', '{"collapsed":[]}', '{"collapsed":"daily"}', '{"collapsed":42}']) {
      expect(parseSidebarState(stored), String(stored)).toEqual(DEFAULT_SIDEBAR_STATE);
    }
    for (const raw of [null, undefined, 3, 'x', [], {}, { collapsed: [] }]) expect(sanitizeSidebarState(raw)).toEqual(DEFAULT_SIDEBAR_STATE);
  });

  it('keeps the known groups with a true / false value and drops everything else', () => {
    expect(
      sanitizeSidebarState({ v: 7, collapsed: { daily: true, training: 'yes', coach: 1, profile: null, app: false, nowhere: true, calendar: false }, extra: 1 }),
    ).toEqual({ collapsed: { daily: true, app: false, calendar: false } });
    // an older payload that listed the collapsed groups as an array
    expect(parseSidebarState('{"collapsed":["daily","training"]}')).toEqual(DEFAULT_SIDEBAR_STATE);
    // a payload of a newer version with a group this one does not know
    expect(parseSidebarState('{"v":2,"collapsed":{"daily":true,"insights":true}}')).toEqual({ collapsed: { daily: true } });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Status bar texts
// ---------------------------------------------------------------------------------------------------------------------------

describe('status bar texts', () => {
  const NOW = new Date(2026, 10, 10, 14, 32, 0); // Tuesday 10 November 2026, 14:32 local
  const at = (y: number, mo: number, d: number, h = 12, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s);
  const text = (lastSyncAt: Date | null, syncing = false, now = NOW) => formatSyncStatus({ syncing, lastSyncAt, now });

  it('says Syncing while a sync runs, whatever else is known', () => {
    expect(text(null, true)).toBe(SYNCING_TEXT);
    expect(text(at(2026, 11, 10, 14, 0), true)).toBe('Syncing\u2026');
  });

  it('says Not synced when no source has ever synced (or the date is broken)', () => {
    expect(text(null)).toBe(NOT_SYNCED_TEXT);
    expect(text(new Date(Number.NaN))).toBe('Not synced');
  });

  it('counts the first hour in minutes', () => {
    expect(text(at(2026, 11, 10, 14, 32, 0))).toBe('Synced just now');
    expect(text(at(2026, 11, 10, 14, 31, 40))).toBe('Synced just now');
    expect(text(at(2026, 11, 10, 14, 27, 0))).toBe('Synced 5 min ago');
    expect(text(at(2026, 11, 10, 13, 40, 0))).toBe('Synced 52 min ago');
    expect(text(at(2026, 11, 10, 15, 0, 0))).toBe('Synced just now'); // a clock ahead of ours
  });

  it('names the time of day later today, and yesterday', () => {
    expect(text(at(2026, 11, 10, 11, 5))).toBe('Synced today at 11:05');
    expect(text(at(2026, 11, 10, 0, 1))).toBe('Synced today at 00:01');
    expect(text(at(2026, 11, 9, 20, 0))).toBe('Synced yesterday at 20:00');
    // across midnight: twenty minutes ago is still minutes ago
    expect(text(at(2026, 11, 9, 23, 50), false, at(2026, 11, 10, 0, 10))).toBe('Synced 20 min ago');
    expect(text(at(2026, 11, 9, 22, 0), false, at(2026, 11, 10, 0, 10))).toBe('Synced yesterday at 22:00');
  });

  it('gives a date for anything older, with the year only when it is not this one', () => {
    expect(text(at(2026, 10, 20, 9, 0))).toBe('Synced on Oct 20');
    expect(text(at(2026, 11, 8, 9, 0))).toBe('Synced on Nov 8');
    expect(text(at(2025, 10, 20, 9, 0))).toBe('Synced on Oct 20, 2025');
    expect(text(at(2026, 1, 3, 9, 0))).toBe('Synced on Jan 3');
  });

  it('picks the newest of the dates there are', () => {
    const a = at(2026, 11, 9, 8);
    const b = at(2026, 11, 10, 7);
    expect(newestDate([a, b, null, undefined])).toBe(b);
    expect(newestDate([null, undefined])).toBeNull();
    expect(newestDate([])).toBeNull();
    expect(newestDate([new Date(Number.NaN), a])).toBe(a);
  });

  it('says whether AI is on, and spells the version', () => {
    expect(aiStatusText(true)).toBe('AI: on');
    expect(aiStatusText(false)).toBe('AI: off');
    expect(versionText('1.0.7')).toBe('v1.0.7');
    expect(versionText('v2.1')).toBe('v2.1');
    expect(versionText(' 3.0 ')).toBe('v3.0');
    expect(versionText('')).toBe('');
    expect(versionText(undefined)).toBe('');
    expect(versionText(null)).toBe('');
  });

  it('builds the right side: AI, colour theme, version; an unknown part is left out', () => {
    expect(buildStatusRight({ aiEnabled: false, paletteName: 'Kanagawa Wave', version: '1.0.7' })).toEqual(['AI: off', 'Kanagawa Wave', 'v1.0.7']);
    expect(buildStatusRight({ aiEnabled: true, paletteName: 'Ration Day', version: undefined })).toEqual(['AI: on', 'Ration Day']);
    expect(buildStatusRight({ aiEnabled: true, paletteName: undefined, version: '' })).toEqual(['AI: on']);
  });
});
