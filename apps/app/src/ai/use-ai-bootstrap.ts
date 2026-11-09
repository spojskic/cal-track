import { useEffect } from 'react';
import { AppState, type NativeEventSubscription } from 'react-native';

import { useAiStore } from './ai-store';

let subscribers = 0;
let subscription: NativeEventSubscription | null = null;

/** One shared AppState listener, however many screens mount the bootstrap hook. */
function acquireForegroundRetry(): () => void {
  if (subscribers === 0) {
    subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      const s = useAiStore.getState();
      if (s.loaded && s.apiKey && s.keyStatus === 'unknown' && !s.validating && !s.busy) void s.revalidate();
    });
  }
  subscribers += 1;
  return () => {
    subscribers -= 1;
    if (subscribers === 0) {
      subscription?.remove();
      subscription = null;
    }
  };
}

/**
 * Loads the key from device storage, validates it (GET /key) and loads the image-capable model list; the AI
 * gate opens only when all of that succeeded. Idempotent: mount it in the signed-in app shell AND on AI screens
 * that can be opened directly (deep link / web reload / OAuth return). When the app returns to the foreground
 * after a failed (offline) check it tries again, so a temporary network failure never hides AI all session.
 */
export function useAiBootstrap(): void {
  useEffect(() => {
    void useAiStore.getState().init();
  }, []);
  useEffect(() => acquireForegroundRetry(), []);
}
