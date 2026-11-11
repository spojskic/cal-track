// Pure (no React Native / expo-router imports at runtime): what the desktop sidebar lists, in which group and in which order, and which
// row is highlighted for a path. The sidebar (components/desktop/Sidebar.tsx) only draws this; tools/ui-smoke/src/desktop-shell.test.ts
// checks it.
//
// The rows below "Daily" are the rows of the More screen (components/settings/more-sections.ts): labels, routes and icons are defined
// once, there. A phone shows them on the More screen, a desktop window in this sidebar (which has no "More" item).
import { buildMoreSections, type MoreSymbol } from '../settings/more-sections';

export type SidebarGroupId = 'daily' | 'training' | 'coach' | 'profile' | 'connections' | 'app' | 'admin';

export interface SidebarRow {
  /** Stable key, not shown. */
  id: string;
  /** Also the accessible name of the row (the browser smoke clicks the links by it). */
  label: string;
  /** An expo-router path. A plain string so this file stays pure; the sidebar casts it to `Href`. */
  href: string;
  symbol: MoreSymbol;
  /** Small status text at the right of the row ("On" / "Off"); only where it is known without a query. */
  badge?: string;
  /** Path prefixes besides `href` on which the row stays highlighted (a food's detail page keeps "Foods" lit). */
  alsoActiveOn?: readonly string[];
}

export interface SidebarGroup {
  id: SidebarGroupId;
  /** The small heading above the rows; also the accessible name of the button that collapses the group. */
  label: string;
  rows: SidebarRow[];
}

export const DASHBOARD_ROW: SidebarRow = {
  id: 'dashboard',
  label: 'Dashboard',
  href: '/',
  symbol: { ios: 'chart.bar.fill', android: 'bar_chart', web: 'bar_chart' },
};

export const DIARY_ROW: SidebarRow = {
  id: 'diary',
  label: 'Diary',
  href: '/diary',
  symbol: { ios: 'book.fill', android: 'menu_book', web: 'menu_book' },
};

export const FOODS_ROW: SidebarRow = {
  id: 'foods',
  label: 'Foods',
  href: '/foods',
  symbol: { ios: 'fork.knife', android: 'restaurant', web: 'restaurant' },
  // The food, recipe and saved meal pages are reached from the Foods list (and are where "Foods" would lead back to).
  alsoActiveOn: ['/food', '/recipe', '/saved-meal'],
};

/**
 * The three pages that are tabs on a phone (the fourth, More, has no row here: its contents are the other groups). Their symbols are
 * the ones of the phone's bottom bar: components/app-nav.tsx reads them from the rows above, so a tab has the same icon in both.
 */
export const TAB_ROWS: readonly SidebarRow[] = [DASHBOARD_ROW, DIARY_ROW, FOODS_ROW];

/**
 * Rows of the More screen that stay highlighted on more paths than their own. (The add flows - /add, /search, /scan, /ai/*,
 * /exercise, /biometric, /note, /water - highlight nothing: they are reached from every page and belong to none.)
 */
const ALSO_ACTIVE_ON: Readonly<Record<string, readonly string[]>> = {
  // The Garmin sign-in is a step of Connected apps & devices.
  integrations: ['/settings/garmin-sign-in'],
};

/**
 * The groups of the sidebar, top to bottom: Daily (the three tab pages), then the sections of the More screen (Training, Coach,
 * Profile, Connections, App, and Admin for the super admin) with their rows as the More screen lists them: the Coach row only when the
 * AI gate is open, the AI row with its On / Off badge.
 */
export function buildSidebarGroups({ aiEnabled, isAdmin = false }: { aiEnabled: boolean; isAdmin?: boolean }): SidebarGroup[] {
  const groups: SidebarGroup[] = [{ id: 'daily', label: 'Daily', rows: TAB_ROWS.map((row) => ({ ...row })) }];
  for (const section of buildMoreSections({ aiEnabled, isAdmin })) {
    // The account section is the footer of the sidebar (the signed-in email and Sign out), not a list of rows.
    if (section.id === 'account') continue;
    groups.push({
      id: section.id,
      label: section.label,
      rows: section.rows.map((row) => {
        const also = ALSO_ACTIVE_ON[row.id];
        return {
          id: row.id,
          label: row.label,
          href: row.href,
          symbol: row.symbol,
          ...(row.badge !== undefined ? { badge: row.badge } : {}),
          ...(also ? { alsoActiveOn: also } : {}),
        };
      }),
    });
  }
  return groups;
}

/** The accessible name of a row: its label, and the status text after it when it has one ("AI (optional). Off"), like the More row. */
export function rowAccessibleName(row: Pick<SidebarRow, 'label' | 'badge'>): string {
  return [row.label, row.badge].filter(Boolean).join('. ');
}

/** `/diary/`, `/diary?date=2026-11-09` and `/diary#x` all mean `/diary`; nothing at all means the dashboard. */
export function normalizePath(path: string): string {
  const bare = (path.split(/[?#]/, 1)[0] ?? '').trim();
  if (bare === '') return '/';
  const trimmed = bare.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** True when `path` is `prefix` or lies below it (`/workouts/abc` is below `/workouts`, `/workoutsx` is not). `/` only matches itself. */
function isAtOrBelow(path: string, prefix: string): boolean {
  if (prefix === '/') return path === '/';
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * The id of the row to highlight for a pathname, or null when no row owns the page. The row whose path matches the most
 * segments wins (`/settings/ai` is the AI row, not a row for `/settings`). Dynamic routes are matched by their prefix.
 */
export function resolveActiveRowId(groups: readonly SidebarGroup[], pathname: string): string | null {
  const path = normalizePath(pathname);
  let best: { id: string; length: number } | null = null;
  for (const group of groups) {
    for (const row of group.rows) {
      for (const prefix of [row.href, ...(row.alsoActiveOn ?? [])]) {
        if (isAtOrBelow(path, prefix) && (best === null || prefix.length > best.length)) best = { id: row.id, length: prefix.length };
      }
    }
  }
  return best?.id ?? null;
}
