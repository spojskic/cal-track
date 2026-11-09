import { router } from 'expo-router';

/** Leaves an AI flow after a successful save, the same way the food flow does (back to where the user came from). */
export function leaveAiFlow(): void {
  if (router.canDismiss()) router.dismissAll();
  else if (router.canGoBack()) router.back();
  else router.replace('/');
}
