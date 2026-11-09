import { router, type Href } from 'expo-router';

/**
 * Navigates by path. Hrefs are cast because typed routes only know a path once its file exists and the route
 * types were regenerated.
 */
export function open(pathname: string, params?: Record<string, string | number>): void {
  router.push((params ? { pathname, params } : pathname) as unknown as Href);
}

/** Replaces the current screen. */
export function replaceWith(pathname: string, params?: Record<string, string | number>): void {
  router.replace((params ? { pathname, params } : pathname) as unknown as Href);
}

export function goBackOr(fallback: string): void {
  if (router.canGoBack()) router.back();
  else router.replace(fallback as unknown as Href);
}

export function openRecipe(id: string): void {
  open('/recipe/[id]', { id });
}

export function openFood(id: string, kind?: string): void {
  if (kind === 'recipe') openRecipe(id);
  else open('/food/[id]', { id });
}

export function openSavedMeal(id: string): void {
  open('/saved-meal/[id]', { id });
}
