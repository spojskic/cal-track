/**
 * Turns any thrown value from the AI layer into something safe and helpful to show in the UI.
 * The API key is redacted from every message.
 */

import { isAbortError, isNoLabelFoundError, isOpenRouterError, redactSecrets } from './errors';

export interface AiErrorPresentation {
  message: string;
  /** Extra advice line, e.g. suggest another model. */
  hint?: string;
  /** Machine-readable kind ('auth' | 'credits' | ... | 'aborted' | 'unknown'). */
  kind: string;
  retryable: boolean;
  /** The failure looks model-specific: offer "Try another model". */
  tryAnotherModel: boolean;
  /** The key is bad or missing: offer "Reconnect". */
  needsReconnect: boolean;
}

export function presentAiError(e: unknown, secrets: Array<string | null | undefined> = []): AiErrorPresentation {
  const extra = secrets.filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (isAbortError(e)) {
    return { message: 'Cancelled.', kind: 'aborted', retryable: true, tryAnotherModel: false, needsReconnect: false };
  }
  if (isNoLabelFoundError(e)) {
    return { message: e.message, kind: 'no_label', retryable: true, tryAnotherModel: false, needsReconnect: false };
  }
  if (isOpenRouterError(e)) {
    const tryAnotherModel = e.kind === 'moderation' || e.kind === 'invalid_output' || e.kind === 'bad_request';
    return {
      message: redactSecrets(e.userMessage, ...extra),
      hint: tryAnotherModel ? 'Try another model in Settings > AI.' : undefined,
      kind: e.kind,
      retryable: e.retryable,
      tryAnotherModel,
      needsReconnect: e.kind === 'auth',
    };
  }
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const safe = redactSecrets(raw, ...extra).trim();
  return {
    message: safe || 'Something went wrong. Please try again.',
    kind: 'unknown',
    retryable: true,
    tryAnotherModel: false,
    needsReconnect: false,
  };
}
