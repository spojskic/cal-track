import { isAbortError, presentAiError, type AiErrorPresentation } from '@cal/ai';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useAiStore } from './ai-store';

export interface RunContext {
  signal: AbortSignal;
  /** Updates the progress text. */
  setLabel: (label: string) => void;
}

export interface AiRunState<T> {
  stage: 'idle' | 'working' | 'done' | 'error';
  label: string;
  result: T | null;
  error: AiErrorPresentation | null;
}

const IDLE = { stage: 'idle', label: '', result: null, error: null } as const;

/**
 * Runs one cancellable AI task and exposes its progress / result / friendly error. Cancelling (or leaving
 * the screen) aborts the in-flight OpenRouter request. Error text is redacted with the live key.
 */
export function useAiRun<T>() {
  const [state, setState] = useState<AiRunState<T>>(IDLE);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const run = useCallback(async (task: (ctx: RunContext) => Promise<T>): Promise<void> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ stage: 'working', label: '', result: null, error: null });
    try {
      const result = await task({
        signal: controller.signal,
        setLabel: (label) => {
          if (!controller.signal.aborted) setState((s) => (s.stage === 'working' ? { ...s, label } : s));
        },
      });
      if (controller.signal.aborted) return;
      setState({ stage: 'done', label: '', result, error: null });
    } catch (e) {
      if (controller.signal.aborted || isAbortError(e)) return;
      const presented = presentAiError(e, [useAiStore.getState().apiKey]);
      setState({ stage: 'error', label: '', result: null, error: presented });
      // 401 mid-session: the key was revoked. Re-check it so the gate closes and AI UI disappears.
      if (presented.needsReconnect) void useAiStore.getState().revalidate();
    }
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState(IDLE);
  }, []);

  return { ...state, run, cancel: reset, reset };
}
