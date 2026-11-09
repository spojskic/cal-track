import { createOpenRouterClient, type FetchLike, type OpenRouterClient } from '@cal/ai';
import { fetch as expoFetch } from 'expo/fetch';
import { Platform } from 'react-native';

import { ensureAiRuntime } from './runtime';

export const APP_TITLE = 'Cal Track';

/**
 * `fetch` handed to @cal/ai. On native it is `expo/fetch` (WinterCG fetch with a streaming `response.body`;
 * React Native's built-in fetch cannot stream). On web the browser's own fetch is used (undefined = default).
 * Always call OpenRouter directly from the device: the key never goes through our backend.
 */
export function getAiFetch(): FetchLike | undefined {
  return Platform.OS === 'web' ? undefined : (expoFetch as unknown as FetchLike);
}

function webOrigin(): string | undefined {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
  return window.location?.origin;
}

/**
 * Builds an OpenRouter client for `apiKey` (may be '' for the public /models endpoint).
 * Attribution headers: X-Title always, HTTP-Referer on web only (there is no app URL on native).
 */
export function createAiClient(apiKey: string): OpenRouterClient {
  ensureAiRuntime();
  return createOpenRouterClient({
    apiKey,
    fetch: getAiFetch(),
    appTitle: APP_TITLE,
    appUrl: webOrigin(),
    // Vision models can be slow; the client still retries 408/429/5xx twice.
    timeoutMs: 90_000,
    maxRetries: 2,
  });
}
