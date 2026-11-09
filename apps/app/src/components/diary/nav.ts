import { router, type Href } from 'expo-router';

/**
 * Navigates to a route owned by another agent. The hrefs are cast because typed routes only know a path
 * once its file exists.
 */
export function go(pathname: string, params?: Record<string, string | number>): void {
  router.push((params ? { pathname, params } : pathname) as unknown as Href);
}
