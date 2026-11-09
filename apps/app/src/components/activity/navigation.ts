import { router } from 'expo-router';

/** Dismisses the current screen; falls back to the dashboard when opened directly (deep link / web reload). */
export function closeScreen() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

export function errorMessage(e: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string' && e.message) {
    return e.message;
  }
  return fallback;
}
