// Pure (no React Native / expo-router imports at runtime): where the desktop shell (sidebar + status bar) is shown, how a click in the
// sidebar navigates and the parent segment of the slim page header. components/desktop/DesktopFrame.tsx and components/stack-header.tsx
// use it; tools/ui-smoke/src/desktop-shell.test.ts checks it.
import { normalizePath } from './sidebar-model';

/**
 * Routes that are drawn WITHOUT the sidebar and status bar, even in a wide window:
 *  - /sign-in    the sign-in screen (also: nobody is signed in, so there is nothing to navigate to),
 *  - /onboarding the first-run wizard (a full-screen flow that has to be finished first),
 *  - /scan       the barcode camera, which wants the whole window.
 * Everything else (settings, coach, workouts, search, food and recipe pages, the add sheet, ...) is a screen of the shell.
 */
export const SHELL_EXCLUDED_PATHS: readonly string[] = ['/sign-in', '/onboarding', '/scan'];

function isAtOrBelow(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function isShellExcludedPath(pathname: string): boolean {
  const path = normalizePath(pathname);
  return SHELL_EXCLUDED_PATHS.some((prefix) => isAtOrBelow(path, prefix));
}

export interface ShellVisibility {
  /** The window is at least WIDE_BREAKPOINT wide (a phone never gets the shell). */
  wide: boolean;
  signedIn: boolean;
  /** False while the signed-in user still has to finish onboarding. */
  onboarded: boolean;
  pathname: string;
}

/** Whether the root layout draws the sidebar and the status bar around the screens. */
export function shouldShowDesktopShell({ wide, signedIn, onboarded, pathname }: ShellVisibility): boolean {
  return wide && signedIn && onboarded && !isShellExcludedPath(pathname);
}

/** The pages that are tabs of the (app) layout on a phone. `/more` is one of them, but a desktop window has no such page. */
const TAB_PATHS: readonly string[] = ['/', '/diary', '/foods', '/more'];

export function isTabPath(pathname: string): boolean {
  return TAB_PATHS.includes(normalizePath(pathname));
}

/**
 * What a click on a sidebar row does:
 *  - 'none'      the page is already open,
 *  - 'navigate'  `router.navigate`: from a tab page, to another tab (switches the tab) or to a page that is not a tab (pushed),
 *  - 'dismissTo' `router.dismissTo`: from a page that is not a tab, back to a tab: the (app) screen that is already in the stack is
 *                shown again. `navigate` would mount a SECOND copy of the tabs (the old one stays hidden underneath, and every query
 *                of the dashboard or the diary would run twice),
 *  - 'replace'   `router.replace`: from a page that is not a tab, to another page that is not a tab, so that clicking through the
 *                sidebar swaps pages instead of piling one on top of the other (Back still leads to the tab below).
 */
export type SidebarNavigation = 'none' | 'navigate' | 'dismissTo' | 'replace';

export function sidebarNavigation(currentPathname: string, targetHref: string): SidebarNavigation {
  const current = normalizePath(currentPathname);
  const target = normalizePath(targetHref);
  if (current === target) return 'none';
  if (isTabPath(target)) return isTabPath(current) ? 'navigate' : 'dismissTo';
  return isTabPath(current) ? 'navigate' : 'replace';
}

/**
 * The parent of a page, shown in muted type before its title in the slim page header ("Settings > Display & units",
 * "Workouts > Morning run"). Null for a page that has no parent to name. Takes a path or an expo-router route name with a leading
 * slash (`/workouts/[id]`).
 */
export function breadcrumbParent(pathname: string): string | null {
  // An index route is named `workouts/index`: it is the page `/workouts`, which has no parent.
  const path = normalizePath(pathname).replace(/\/index$/, '') || '/';
  if (/^\/settings\/[^/]+/.test(path)) return 'Settings';
  if (/^\/workouts\/[^/]+/.test(path)) return 'Workouts';
  if (/^\/coach\/[^/]+/.test(path)) return 'Coach';
  if (/^\/(food|recipe|saved-meal)\/[^/]+/.test(path)) return 'Foods';
  return null;
}
