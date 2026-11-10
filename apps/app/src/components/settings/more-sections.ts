// Pure (no React Native / expo-router imports at runtime): what the More screen lists, in which section and in which column on a
// wide screen. The screen (app/(app)/more.tsx) only draws this; the unit test (tools/ui-smoke/src/more-sections.test.ts) checks it.
import type { SymbolViewProps } from 'expo-symbols';

/** A symbol for every platform: SF Symbols on iOS, Material Symbols on Android and the web build (same style as components/app-nav.tsx). */
export type MoreSymbol = Required<Extract<SymbolViewProps['name'], object>>;

export type MoreSectionId = 'training' | 'coach' | 'profile' | 'connections' | 'app' | 'account';

/** The two columns of the wide layout. On a phone the sections just follow one another in the order of the list. */
export type MoreColumn = 'left' | 'right';

export interface MoreRow {
  /** Stable key, not shown. */
  id: string;
  /** Also the accessible name of the row (with the description): the browser smoke clicks rows by it. */
  label: string;
  description: string;
  /** An expo-router path. A plain string so this file stays pure; the screen casts it to `Href`. */
  href: string;
  symbol: MoreSymbol;
  /** Small status text at the right of the row ("On" / "Off"); only where it is known without a query. */
  badge?: string;
}

export interface MoreSection {
  id: MoreSectionId;
  /** The small heading above the section card. */
  label: string;
  column: MoreColumn;
  /** The "account" section has no rows: the screen draws the signed-in email and the Sign out button. */
  rows: MoreRow[];
}

/**
 * Below this window width the More screen is one column; from here on it is two columns in a content area of `MORE_WIDE_WIDTH`.
 * The shell switches to the sidebar at WIDE_BREAKPOINT (900), but that sidebar takes 232 px: at 900 each column would get only ~310 px
 * (a row's text then has ~210 px) and "Connected apps & devices" could wrap, so the columns start a little later, at ~360 px each.
 */
export const MORE_TWO_COLUMNS_FROM = 1000;
/** Widest the content gets in the two-column layout (the other screens stop at MAX_CONTENT_WIDTH, 880). */
export const MORE_WIDE_WIDTH = 1040;

export function buildMoreSections({ aiEnabled }: { aiEnabled: boolean }): MoreSection[] {
  const coachRows: MoreRow[] = [];
  if (aiEnabled) {
    coachRows.push({
      id: 'coach',
      label: 'Coach',
      description: 'Chat about your nutrition, training and recovery',
      href: '/coach',
      symbol: { ios: 'bubble.left.and.bubble.right', android: 'forum', web: 'forum' },
    });
  }
  coachRows.push({
    id: 'ai',
    label: aiEnabled ? 'AI Coach & keys' : 'AI (optional)',
    description: aiEnabled ? 'Manage your AI key, model and coach' : 'Connect your own key to enable AI features',
    href: '/settings/ai',
    symbol: { ios: 'sparkles', android: 'auto_awesome', web: 'auto_awesome' },
    badge: aiEnabled ? 'On' : 'Off',
  });

  return [
    {
      id: 'training',
      label: 'Training',
      column: 'left',
      rows: [
        {
          id: 'workouts',
          label: 'Workouts',
          // Always listed: the list needs no AI key, only "Discuss with coach" inside a workout does.
          description: 'Every workout with heart rate, zones and sets; open one to talk about it',
          href: '/workouts',
          symbol: { ios: 'figure.run', android: 'directions_run', web: 'directions_run' },
        },
      ],
    },
    { id: 'coach', label: 'Coach', column: 'left', rows: coachRows },
    {
      id: 'profile',
      label: 'Profile',
      column: 'right',
      rows: [
        {
          id: 'targets',
          label: 'Profile & targets',
          description: 'Energy and macro targets, weight goal, BMR and activity',
          href: '/settings/targets',
          symbol: { ios: 'target', android: 'flag', web: 'flag' },
        },
        {
          id: 'profile',
          label: 'Personal details',
          description: 'Sex, birthdate, height, log your weight',
          href: '/settings/profile',
          symbol: { ios: 'person.crop.circle', android: 'person', web: 'person' },
        },
        {
          id: 'nutrients',
          label: 'Nutrient targets',
          description: 'Vitamins, minerals and other daily targets',
          href: '/settings/nutrients',
          symbol: { ios: 'leaf', android: 'eco', web: 'eco' },
        },
      ],
    },
    {
      id: 'connections',
      label: 'Connections',
      column: 'left',
      rows: [
        {
          id: 'integrations',
          label: 'Connected apps & devices',
          description: 'Apple Health, Health Connect, Garmin',
          href: '/settings/integrations',
          symbol: { ios: 'applewatch', android: 'watch', web: 'watch' },
        },
      ],
    },
    {
      id: 'app',
      label: 'App',
      column: 'right',
      rows: [
        {
          id: 'display',
          label: 'Display & units',
          description: 'Colour theme, light or dark mode, metric or imperial units',
          href: '/settings/display',
          symbol: { ios: 'paintpalette', android: 'palette', web: 'palette' },
        },
        {
          id: 'about',
          label: 'About',
          description: 'Version, data sources and licences',
          href: '/settings/about',
          symbol: { ios: 'info.circle', android: 'info', web: 'info' },
        },
      ],
    },
    { id: 'account', label: 'Account', column: 'right', rows: [] },
  ];
}

/** The sections of one column of the wide layout, in their order. */
export function sectionsInColumn(sections: readonly MoreSection[], column: MoreColumn): MoreSection[] {
  return sections.filter((section) => section.column === column);
}
