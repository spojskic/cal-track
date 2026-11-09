import type { ModelInfo, OpenRouterClient } from '@cal/ai';
import { useMemo } from 'react';

import { selectSelectedModel, useAiStore } from './ai-store';
import { createAiClient } from './create-client';
import { useAiGate } from './use-ai-gate';

export interface AiClientHandle {
  client: OpenRouterClient;
  /** The selected (image-capable) model. */
  model: ModelInfo;
  modelId: string;
}

/**
 * The OpenRouter client + selected model, or null while the AI gate is closed (no validated key / no
 * image-capable model). Memoised per key; requests go straight from the device to OpenRouter.
 */
export function useAiClient(): AiClientHandle | null {
  const gate = useAiGate();
  const apiKey = useAiStore((s) => s.apiKey);
  const model = useAiStore(selectSelectedModel);
  const client = useMemo(() => (gate.enabled && apiKey ? createAiClient(apiKey) : null), [gate.enabled, apiKey]);
  return useMemo(() => (client && model ? { client, model, modelId: model.id } : null), [client, model]);
}
