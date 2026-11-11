// Pure (no React Native / expo-router imports at runtime): what the More screen lists and in which section. The screen
// (app/(app)/more.tsx, a phone's fourth tab) only draws this; the desktop sidebar (components/desktop/sidebar-model.ts) lists the same
// rows in its own groups, so labels, routes and icons are defined once, here. The unit test (tools/ui-smoke/src/more-sections.test.ts)
// checks it.
import type { SymbolViewProps } from 'expo-symbols';

import { friendRequestsBadge } from '../friends/friends-view';

/** A symbol for every platform: SF Symbols on iOS, Material Symbols on Android and the web build (same style as components/app-nav.tsx). */
export type MoreSymbol = Required<Extract<SymbolViewProps['name'], object>>;

export type MoreSectionId = 'training' | 'coach' | 'profile' | 'connections' | 'app' | 'admin' | 'account';

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
  /** The "account" section has no rows: the screen draws the signed-in email and the Sign out button (the sidebar's footer on a desktop). */
  rows: MoreRow[];
}

/**
 * `isAdmin`: the signed-in user is the super admin (profiles.is_admin). Only then is the Admin section listed; the database refuses the
 * admin RPCs for everybody else anyway. `friendRequests`: how many friend requests wait for an answer; the Friends row shows it.
 */
export function buildMoreSections({
  aiEnabled,
  isAdmin = false,
  friendRequests = 0,
}: {
  aiEnabled: boolean;
  isAdmin?: boolean;
  friendRequests?: number;
}): MoreSection[] {
  const requests = friendRequestsBadge(friendRequests);
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

  const adminSections: MoreSection[] = isAdmin
    ? [
        {
          id: 'admin',
          label: 'Admin',
          rows: [
            {
              id: 'invites',
              label: 'Invite people',
              description: 'Create invite codes and see which are still unused',
              href: '/settings/invites',
              symbol: { ios: 'person.badge.plus', android: 'person_add', web: 'person_add' },
            },
          ],
        },
      ]
    : [];

  return [
    {
      id: 'training',
      label: 'Training',
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
    { id: 'coach', label: 'Coach', rows: coachRows },
    {
      id: 'profile',
      label: 'Profile',
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
        {
          id: 'friends',
          label: 'Friends',
          description: 'Share your custom foods and recipes with friends',
          href: '/friends',
          symbol: { ios: 'person.2', android: 'group', web: 'group' },
          ...(requests !== undefined ? { badge: requests } : {}),
        },
      ],
    },
    {
      id: 'connections',
      label: 'Connections',
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
    ...adminSections,
    { id: 'account', label: 'Account', rows: [] },
  ];
}
