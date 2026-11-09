import { describe, expect, it } from 'vitest';
import {
  PREFERRED_VISION_MODEL_IDS,
  computeAiGate,
  keyStatusFromValidation,
  pickDefaultVisionModel,
  validateKey,
  type KeyStatus,
} from './gate';
import { OpenRouterError } from './errors';
import type { KeyInfo, ModelInfo } from './types';

function model(over: Partial<ModelInfo> & { id: string }): ModelInfo {
  return {
    name: over.id,
    contextLength: 128_000,
    inputModalities: over.supportsImages === false ? ['text'] : ['text', 'image'],
    supportsImages: true,
    supportsStructuredOutputs: true,
    supportsTools: true,
    promptPricePerM: 0.3,
    completionPricePerM: 1.2,
    isFree: false,
    ...over,
  };
}

const VISION = model({ id: 'x/vision' });
const TEXT_ONLY = model({ id: 'x/text', supportsImages: false });

describe('computeAiGate truth table', () => {
  const statuses: KeyStatus[] = ['unknown', 'valid', 'invalid'];
  const models: Array<[string, ModelInfo | null | undefined]> = [
    ['vision', VISION],
    ['text-only', TEXT_ONLY],
    ['null', null],
    ['undefined', undefined],
  ];

  it('enables only with key + valid status + vision model', () => {
    const enabled: string[] = [];
    for (const present of [true, false]) {
      for (const status of statuses) {
        for (const [label, m] of models) {
          const gate = computeAiGate({ apiKeyPresent: present, keyStatus: status, model: m });
          if (gate.enabled) enabled.push(`${present}/${status}/${label}`);
          expect(gate.enabled).toBe(gate.reason === null);
        }
      }
    }
    expect(enabled).toEqual(['true/valid/vision']);
  });

  it('reports the first failing reason', () => {
    expect(computeAiGate({ apiKeyPresent: false, keyStatus: 'valid', model: VISION })).toEqual({ enabled: false, reason: 'no_key' });
    expect(computeAiGate({ apiKeyPresent: true, keyStatus: 'invalid', model: VISION })).toEqual({ enabled: false, reason: 'invalid_key' });
    expect(computeAiGate({ apiKeyPresent: true, keyStatus: 'unknown', model: VISION })).toEqual({ enabled: false, reason: 'checking' });
    expect(computeAiGate({ apiKeyPresent: true, keyStatus: 'valid', model: null })).toEqual({ enabled: false, reason: 'no_model' });
    expect(computeAiGate({ apiKeyPresent: true, keyStatus: 'valid' })).toEqual({ enabled: false, reason: 'no_model' });
    expect(computeAiGate({ apiKeyPresent: true, keyStatus: 'valid', model: TEXT_ONLY })).toEqual({
      enabled: false,
      reason: 'model_not_vision',
    });
    expect(computeAiGate({ apiKeyPresent: true, keyStatus: 'valid', model: VISION })).toEqual({ enabled: true, reason: null });
  });
});

describe('validateKey', () => {
  const info: KeyInfo = {
    label: 'k',
    limit: null,
    limitRemaining: null,
    limitReset: null,
    usage: 0,
    usageDaily: 0,
    usageMonthly: 0,
    isFreeTier: false,
    isManagementKey: false,
    expiresAt: null,
    freeModelDailyRequests: null,
  };

  it('valid key', async () => {
    const r = await validateKey({ getKeyInfo: async () => info });
    expect(r).toEqual({ status: 'valid', info });
    expect(keyStatusFromValidation(r)).toBe('valid');
  });

  it('401 is invalid', async () => {
    const r = await validateKey({
      getKeyInfo: async () => {
        throw new OpenRouterError({ kind: 'auth', status: 401 });
      },
    });
    expect(r.status).toBe('invalid');
    expect(keyStatusFromValidation(r)).toBe('invalid');
  });

  it('network and server errors are "error", not "invalid"', async () => {
    for (const kind of ['network', 'provider', 'timeout', 'rate_limit'] as const) {
      const r = await validateKey({
        getKeyInfo: async () => {
          throw new OpenRouterError({ kind });
        },
      });
      expect(r.status).toBe('error');
      expect(keyStatusFromValidation(r)).toBe('unknown');
    }
    const r = await validateKey({
      getKeyInfo: async () => {
        throw new TypeError('boom');
      },
    });
    expect(r.status).toBe('error');
  });

  it('rethrows aborts', async () => {
    await expect(
      validateKey({
        getKeyInfo: async () => {
          throw Object.assign(new Error('x'), { name: 'AbortError' });
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('pickDefaultVisionModel', () => {
  it('returns null when nothing supports images', () => {
    expect(pickDefaultVisionModel([TEXT_ONLY])).toBeNull();
    expect(pickDefaultVisionModel([])).toBeNull();
  });

  it('prefers the curated list in order', () => {
    const list = [
      model({ id: 'zzz/cheap', promptPricePerM: 0.01, completionPricePerM: 0.01 }),
      model({ id: PREFERRED_VISION_MODEL_IDS[1]! }),
      model({ id: PREFERRED_VISION_MODEL_IDS[0]! }),
    ];
    expect(pickDefaultVisionModel(list)?.id).toBe(PREFERRED_VISION_MODEL_IDS[0]);
  });

  it('accepts custom preferred ids and skips curated non-vision entries', () => {
    const list = [
      model({ id: 'a/text', supportsImages: false }),
      model({ id: 'b/vision' }),
    ];
    expect(pickDefaultVisionModel(list, { preferredIds: ['a/text', 'b/vision'] })?.id).toBe('b/vision');
  });

  it('otherwise prefers structured outputs, non-free, large context, cheap, recent', () => {
    const list = [
      model({ id: 'a/no-structured', supportsStructuredOutputs: false, promptPricePerM: 0.01, completionPricePerM: 0.01 }),
      model({ id: 'b/free:free', isFree: true, promptPricePerM: 0, completionPricePerM: 0 }),
      model({ id: 'c/pricey', promptPricePerM: 10, completionPricePerM: 30 }),
      model({ id: 'd/small-ctx', contextLength: 8000, promptPricePerM: 0.1, completionPricePerM: 0.1 }),
      model({ id: 'e/old', promptPricePerM: 0.2, completionPricePerM: 0.4, created: 1_600_000_000 }),
      model({ id: 'f/new', promptPricePerM: 0.2, completionPricePerM: 0.4, created: 1_700_000_000 }),
    ];
    expect(pickDefaultVisionModel(list)?.id).toBe('f/new');
  });

  it('is deterministic regardless of input order', () => {
    const list = [
      model({ id: 'm/b', created: 1 }),
      model({ id: 'm/a', created: 1 }),
      model({ id: 'm/c', created: 1 }),
    ];
    const forward = pickDefaultVisionModel(list)?.id;
    const reversed = pickDefaultVisionModel([...list].reverse())?.id;
    expect(forward).toBe('m/a');
    expect(reversed).toBe('m/a');
  });

  it('falls back to free or pricey models when nothing else exists', () => {
    expect(pickDefaultVisionModel([model({ id: 'only/free:free', isFree: true, promptPricePerM: 0, completionPricePerM: 0 })])?.id).toBe(
      'only/free:free',
    );
    expect(pickDefaultVisionModel([model({ id: 'only/pricey', promptPricePerM: 15, completionPricePerM: 60 })])?.id).toBe(
      'only/pricey',
    );
  });
});
