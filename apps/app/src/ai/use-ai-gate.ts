/**
 * Single source of truth for "should any AI UI be visible?".
 * Placeholder until the key store + @cal/ai gate are wired (see packages/ai computeAiGate).
 * Rule: AI is visible ONLY with a validated OpenRouter key AND an image-capable model.
 */
export interface AiGateState {
  enabled: boolean;
  reason: 'no_key' | 'invalid_key' | 'checking' | 'no_model' | 'model_not_vision' | null;
}

export function useAiGate(): AiGateState {
  return { enabled: false, reason: 'no_key' };
}
