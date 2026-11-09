import { computeAiGate, type AiGate, type KeyStatus, type ModelInfo } from '@cal/ai';
import { useMemo } from 'react';

import { selectSelectedModel, useAiStore } from './ai-store';

/**
 * Single source of truth for "should any AI UI be visible?".
 * Rule: AI is visible ONLY with (1) a key on this device, (2) validated against OpenRouter (GET /key) and
 * (3) a selected model that accepts image input. See computeAiGate in @cal/ai.
 */
export type AiGateState = AiGate;

export interface GateInputs {
  loaded: boolean;
  hasKey: boolean;
  keyStatus: KeyStatus;
  model: ModelInfo | null;
}

/** Pure wiring: until the stored key has been loaded and checked the gate reads 'checking' (AI hidden). */
export function deriveAiGate(input: GateInputs): AiGateState {
  if (!input.loaded) return { enabled: false, reason: 'checking' };
  return computeAiGate({ apiKeyPresent: input.hasKey, keyStatus: input.keyStatus, model: input.model });
}

export function useAiGate(): AiGateState {
  const loaded = useAiStore((s) => s.loaded);
  const hasKey = useAiStore((s) => s.apiKey !== null);
  const keyStatus = useAiStore((s) => s.keyStatus);
  const model = useAiStore(selectSelectedModel);
  return useMemo(() => deriveAiGate({ loaded, hasKey, keyStatus, model }), [loaded, hasKey, keyStatus, model]);
}
