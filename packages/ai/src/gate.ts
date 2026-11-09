/**
 * AI gate: ALL AI UI must be hidden unless
 *   1. an API key exists on this device,
 *   2. the key was validated against OpenRouter (GET /key), and
 *   3. the selected model accepts image input.
 */

import { isOpenRouterError } from './errors';
import type { OpenRouterClient } from './openrouter';
import type { KeyInfo, ModelInfo } from './types';

export type KeyStatus = 'unknown' | 'valid' | 'invalid';

export type AiGateReason = 'no_key' | 'invalid_key' | 'checking' | 'no_model' | 'model_not_vision';

export interface AiGate {
  enabled: boolean;
  reason: AiGateReason | null;
}

export interface AiGateInput {
  apiKeyPresent: boolean;
  /**
   * 'unknown' covers "not validated yet" AND "validation failed for a network
   * reason" (see `validateKey` status 'error'); UI should keep AI hidden.
   */
  keyStatus: KeyStatus;
  model?: ModelInfo | null;
}

export function computeAiGate(input: AiGateInput): AiGate {
  if (!input.apiKeyPresent) return { enabled: false, reason: 'no_key' };
  if (input.keyStatus === 'invalid') return { enabled: false, reason: 'invalid_key' };
  if (input.keyStatus !== 'valid') return { enabled: false, reason: 'checking' };
  if (!input.model) return { enabled: false, reason: 'no_model' };
  if (!input.model.supportsImages) return { enabled: false, reason: 'model_not_vision' };
  return { enabled: true, reason: null };
}

export type ValidateKeyResult =
  | { status: 'valid'; info: KeyInfo }
  | { status: 'invalid'; error: string }
  | { status: 'error'; error: string };

/**
 * Validates a key via GET /key.
 *  - 401 (auth error)        -> 'invalid'
 *  - anything else that fails -> 'error' (offline, 5xx, timeout): NOT proof the key is bad
 */
export async function validateKey(
  client: Pick<OpenRouterClient, 'getKeyInfo'>,
  opts?: { signal?: AbortSignal },
): Promise<ValidateKeyResult> {
  try {
    const info = await client.getKeyInfo(opts);
    return { status: 'valid', info };
  } catch (e) {
    if (isOpenRouterError(e)) {
      if (e.kind === 'auth') return { status: 'invalid', error: e.userMessage };
      return { status: 'error', error: e.userMessage };
    }
    if (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError') throw e;
    return { status: 'error', error: 'Could not check your OpenRouter key. Try again later.' };
  }
}

/** Maps a validateKey result to the gate's keyStatus ('error' stays 'unknown'). */
export function keyStatusFromValidation(result: ValidateKeyResult): KeyStatus {
  return result.status === 'valid' ? 'valid' : result.status === 'invalid' ? 'invalid' : 'unknown';
}

// ---------------------------------------------------------------------------
// Default vision model
// ---------------------------------------------------------------------------

/**
 * Curated, EDITABLE list of good low-cost vision models, best first. Ids that
 * do not exist in the live catalogue are simply skipped. Review occasionally.
 */
export const PREFERRED_VISION_MODEL_IDS: readonly string[] = [
  'google/gemini-2.5-flash',
  'google/gemini-2.5-flash-lite',
  'openai/gpt-4o-mini',
  'openai/gpt-4.1-mini',
  'anthropic/claude-haiku-4.5',
  'google/gemini-2.0-flash-001',
];

export interface PickDefaultOptions {
  preferredIds?: readonly string[];
  /** Allow ':free' models as the automatic pick. Default false (they are heavily rate limited). */
  allowFree?: boolean;
  /** Ignore models above this blended price (USD per million tokens) when cheaper ones exist. Default 3. */
  maxBlendedPricePerM?: number;
  /** Prefer at least this context length when available. Default 32 000. */
  minContextLength?: number;
}

function blendedPrice(m: ModelInfo): number {
  if (m.promptPricePerM === null || m.completionPricePerM === null) return Number.POSITIVE_INFINITY;
  return (m.promptPricePerM + m.completionPricePerM) / 2;
}

function narrow<T>(items: T[], pred: (x: T) => boolean): T[] {
  const filtered = items.filter(pred);
  return filtered.length > 0 ? filtered : items;
}

function priceBucket(price: number): number {
  if (!Number.isFinite(price)) return 99;
  if (price <= 0.5) return 0;
  if (price <= 1.5) return 1;
  if (price <= 4) return 2;
  return 3;
}

/**
 * Deterministic default for photo logging.
 * 1. first curated id that is available, supports images (and structured outputs if possible)
 * 2. otherwise score: structured outputs > context >= 32k > not free > cheap price bucket > newest > larger context > id
 */
export function pickDefaultVisionModel(
  models: readonly ModelInfo[],
  opts: PickDefaultOptions = {},
): ModelInfo | null {
  const vision = models.filter((m) => m.supportsImages);
  if (vision.length === 0) return null;

  const preferred = opts.preferredIds ?? PREFERRED_VISION_MODEL_IDS;
  for (const id of preferred) {
    const hit = vision.find((m) => m.id === id);
    if (hit && hit.supportsStructuredOutputs) return hit;
  }
  for (const id of preferred) {
    const hit = vision.find((m) => m.id === id);
    if (hit) return hit;
  }

  let pool = [...vision];
  pool = narrow(pool, (m) => m.supportsStructuredOutputs);
  pool = narrow(pool, (m) => m.contextLength >= (opts.minContextLength ?? 32_000));
  if (!opts.allowFree) pool = narrow(pool, (m) => !m.isFree);
  pool = narrow(pool, (m) => blendedPrice(m) <= (opts.maxBlendedPricePerM ?? 3));

  pool.sort((a, b) => {
    const pb = priceBucket(blendedPrice(a)) - priceBucket(blendedPrice(b));
    if (pb !== 0) return pb;
    const created = (b.created ?? 0) - (a.created ?? 0);
    if (created !== 0) return created;
    const ctx = b.contextLength - a.contextLength;
    if (ctx !== 0) return ctx;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return pool[0] ?? null;
}
