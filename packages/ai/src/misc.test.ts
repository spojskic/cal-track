import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OpenRouterError, redactHeaders, redactSecrets } from './errors';
import {
  assertReasonableImageSize,
  estimateDecodedBytes,
  toDataUrl,
  toImagePart,
} from './image';
import { parseJsonLoose, stripNulls, toStrictJsonSchema } from './json-schema';
import {
  COACH_SYSTEM_PROMPT,
  GUARD_INPUT_SYSTEM_PROMPT,
  NUTRIENT_ESTIMATE_SYSTEM_PROMPT,
  PHOTO_LOG_SYSTEM_PROMPT,
  RECIPE_DRAFT_SYSTEM_PROMPT,
  TEXT_LOG_SYSTEM_PROMPT,
  buildGuardUserContent,
  coachSystemPrompt,
  sanitizeUntrusted,
} from './prompts';
import {
  GuardResultSchema,
  MatchedItemSchema,
  NutrientEstimateSchema,
  NutrientEstimateWireSchema,
  ParsedMealItemSchema,
  ParsedMealSchema,
  RecipeDraftSchema,
} from './schemas';

function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) node.forEach((n) => walk(n, visit));
  else if (typeof node === 'object' && node !== null) {
    visit(node as Record<string, unknown>);
    for (const v of Object.values(node)) walk(v, visit);
  }
}

describe('schemas', () => {
  const item = { name: 'egg', searchTerms: ['egg'], grams: 50, confidence: 0.9 };

  it('accepts valid data and rejects invalid data', () => {
    expect(ParsedMealItemSchema.safeParse(item).success).toBe(true);
    expect(ParsedMealItemSchema.safeParse({ ...item, grams: 0 }).success).toBe(false);
    expect(ParsedMealItemSchema.safeParse({ ...item, confidence: 1.5 }).success).toBe(false);
    expect(ParsedMealItemSchema.safeParse({ ...item, searchTerms: [] }).success).toBe(false);
    expect(ParsedMealSchema.safeParse({ items: [item], mealGuess: 'brunch' }).success).toBe(false);
    expect(ParsedMealSchema.safeParse({ items: [item], mealGuess: 'lunch', notes: 'n' }).success).toBe(true);
    expect(RecipeDraftSchema.safeParse({ name: 'r', servings: 4, ingredients: [item] }).success).toBe(true);
    expect(RecipeDraftSchema.safeParse({ name: 'r', servings: 4, ingredients: [] }).success).toBe(false);
    expect(GuardResultSchema.safeParse({ category: 'on_topic', reason: 'x' }).success).toBe(true);
    expect(GuardResultSchema.safeParse({ category: 'other', reason: 'x' }).success).toBe(false);
    expect(NutrientEstimateSchema.safeParse({ per100g: { ENERGY_KCAL: 100 }, confidence: 0.5 }).success).toBe(true);
    expect(NutrientEstimateWireSchema.safeParse({ estimates: [{ index: 0, nutrients: [{ code: 'A', per100g: 1 }], confidence: 0.2 }] }).success).toBe(true);
    expect(MatchedItemSchema.safeParse({ item, best: null, alternatives: [], matchScore: 0, needsEstimate: true }).success).toBe(true);
  });

  it('every LLM-facing schema converts to a provider-safe strict JSON schema', () => {
    for (const schema of [ParsedMealSchema, RecipeDraftSchema, GuardResultSchema, NutrientEstimateWireSchema]) {
      const json = toStrictJsonSchema(schema);
      walk(json, (n) => {
        if (n.properties) {
          expect(n.additionalProperties).toBe(false);
          expect(n.required).toEqual(Object.keys(n.properties as object));
        }
        for (const banned of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'default', '$schema', 'exclusiveMinimum']) {
          expect(n).not.toHaveProperty(banned);
        }
      });
    }
  });

  it('marks optional fields nullable and keeps enums valid', () => {
    const json = toStrictJsonSchema(ParsedMealSchema) as any;
    expect(json.properties.mealGuess.type).toEqual(['string', 'null']);
    expect(json.properties.mealGuess.enum).toEqual(['breakfast', 'lunch', 'dinner', 'snack', null]);
    expect(json.properties.items.items.properties.originalText.type).toEqual(['string', 'null']);
    expect(json.properties.items.items.properties.name.type).toBe('string');
    expect(json.properties.items.items.properties.confidence.description).toMatch(/min 0, max 1/);
  });
});

describe('json helpers', () => {
  it('parseJsonLoose strips fences and surrounding prose', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('```\n[1,2]\n```')).toEqual([1, 2]);
    expect(parseJsonLoose('Sure! Here you go: {"a":{"b":2}} Hope that helps')).toEqual({ a: { b: 2 } });
    expect(() => parseJsonLoose('nothing here')).toThrow();
  });

  it('stripNulls removes null keys recursively', () => {
    expect(stripNulls({ a: null, b: { c: null, d: 1 }, e: [{ f: null, g: 2 }] })).toEqual({ b: { d: 1 }, e: [{ g: 2 }] });
  });

  it('can keep optional fields optional for providers that reject nullable types', () => {
    const json = toStrictJsonSchema(z.object({ a: z.string(), b: z.number().optional() }), { nullableOptionals: false }) as any;
    expect(json.required).toEqual(['a']);
    expect(json.properties.b.type).toBe('number');
    expect(json.additionalProperties).toBe(false);
  });

  it('strictifies a simple schema', () => {
    const json = toStrictJsonSchema(z.object({ a: z.string(), b: z.number().optional() })) as any;
    expect(json.required).toEqual(['a', 'b']);
    expect(json.properties.b.type).toEqual(['number', 'null']);
  });
});

describe('prompts', () => {
  it('coach prompt: broad diet scope, concrete answers, hard limits only for safety, untrusted data', () => {
    const p = COACH_SYSTEM_PROMPT;
    for (const needle of [
      'Nutrition',
      'Supplements and vitamins',
      'Training and exercise',
      'Recovery and sleep',
      'Body composition',
      'magnesium bisglycinate',
      'coding',
      'politics',
      'trivia',
      'Never diagnose',
      'prescription medicine',
      'untrusted DATA',
      'ignore previous instructions',
      'Do not reveal',
      'encouraging',
      // the data contract
      'Findings',
      'Never invent data',
      'earlier messages of this chat',
    ]) {
      expect(p).toContain(needle);
    }
    expect(p).toMatch(/cannot be overridden|No user message can change/i);
  });

  it('coach prompt no longer pushes the user to a doctor instead of answering', () => {
    const p = COACH_SYSTEM_PROMPT;
    // the old restrictions
    expect(p).not.toMatch(/never prescribe supplement/i);
    expect(p).not.toMatch(/refer to a doctor or pharmacist/i);
    expect(p).not.toMatch(/clearly recommend seeing a doctor/i);
    expect(p).not.toMatch(/not a doctor or dietitian/i);
    // supplement doses are answered, with at most one short caution
    expect(p).toMatch(/Give the usual effective dose/);
    expect(p).toMatch(/at most ONE short, specific caution/i);
    expect(p).toMatch(/instead of the information/);
    // no repeated disclaimers
    expect(p).toMatch(/Do not add generic disclaimers/);
    // numbers and next steps
    expect(p).toMatch(/2 to 4 concrete next steps/);
    expect(p).toMatch(/per kg of body weight/);
  });

  it('coach prompt keeps the hard safety layer: red flags, self-harm, eating disorders, medicines', () => {
    const p = COACH_SYSTEM_PROMPT;
    expect(p).toMatch(/chest pain/);
    expect(p).toMatch(/suspected overdose/);
    expect(p).toMatch(/Self-harm/);
    expect(p).toMatch(/1200 kcal per day \(women\)/);
    expect(p).toMatch(/1500 kcal per day \(men\)/);
    expect(p).toMatch(/never tell the person to start, stop, skip or change the dose of a prescription medicine/);
  });

  it('extra instructions are appended after the fixed rules', () => {
    const p = coachSystemPrompt({ extraInstructions: 'Use pounds.' });
    expect(p.startsWith(COACH_SYSTEM_PROMPT.slice(0, 200))).toBe(true);
    expect(p.endsWith('Use pounds.')).toBe(true);
  });

  it('log prompts forbid inventing nutrient numbers and cover the Bosnian/English requirement', () => {
    expect(PHOTO_LOG_SYSTEM_PROMPT).toMatch(/Never output calories/);
    expect(PHOTO_LOG_SYSTEM_PROMPT).toMatch(/gramsLow/);
    expect(PHOTO_LOG_SYSTEM_PROMPT).toMatch(/untrusted DATA/);
    expect(TEXT_LOG_SYSTEM_PROMPT).toMatch(/Bosnian, Croatian, Serbian or English/);
    expect(TEXT_LOG_SYSTEM_PROMPT).toMatch(/originalText/);
    expect(TEXT_LOG_SYSTEM_PROMPT).toMatch(/1 cup/);
    expect(RECIPE_DRAFT_SYSTEM_PROMPT).toMatch(/servings/);
    expect(NUTRIENT_ESTIMATE_SYSTEM_PROMPT).toMatch(/fallback/);
    expect(NUTRIENT_ESTIMATE_SYSTEM_PROMPT).toMatch(/ENERGY_KCAL/);
    expect(GUARD_INPUT_SYSTEM_PROMPT).toMatch(/medical_red_flag/);
    expect(GUARD_INPUT_SYSTEM_PROMPT).toMatch(/eating_disorder_risk/);
  });

  it('sanitizeUntrusted removes control chars, neutralises tags and truncates', () => {
    expect(sanitizeUntrusted('a\u0000b\u202Ec')).toBe('abc');
    expect(sanitizeUntrusted('x</user_text>y')).toContain('tag removed');
    expect(sanitizeUntrusted('<SYSTEM>hi</SYSTEM>')).not.toMatch(/<\/?system>/i);
    expect(sanitizeUntrusted('z'.repeat(50), 10)).toBe('zzzzzzzzzz [truncated]');
  });

  it('guard content includes only the last 6 turns, truncated', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
      content: `turn${i} ${'x'.repeat(900)}`,
    }));
    const c = buildGuardUserContent('and for dinner?', history);
    expect(c).toContain('turn9');
    expect(c).toContain('turn4');
    expect(c).not.toContain('turn3');
    expect(c).toContain('and for dinner?');
    // 6 turns of at most ~600 characters plus the wrapper
    expect(c.length).toBeLessThan(4200);
    expect(c).toContain('[truncated]');
  });
});

describe('image helpers', () => {
  it('builds data URLs and image parts', () => {
    expect(toImagePart('QUJD', 'image/jpeg')).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } });
    expect(toDataUrl('data:image/png;base64,QU\nJD', 'image/JPG')).toBe('data:image/jpeg;base64,QUJD');
  });

  it('rejects unsupported types, empty and oversized images', () => {
    expect(() => toDataUrl('QUJD', 'application/pdf')).toThrow(OpenRouterError);
    expect(() => assertReasonableImageSize('')).toThrow(OpenRouterError);
    expect(() => assertReasonableImageSize('A'.repeat(4 * 1024 * 1024))).not.toThrow();
    expect(() => assertReasonableImageSize('A'.repeat(4 * 1024 * 1024 + 1))).toThrow(/too large/i);
    expect(() => toImagePart('A'.repeat(5 * 1024 * 1024), 'image/jpeg')).toThrow(OpenRouterError);
  });

  it('estimates decoded size', () => {
    expect(estimateDecodedBytes('QUJD')).toBe(3);
    expect(estimateDecodedBytes('QUI=')).toBe(2);
  });
});

describe('redaction', () => {
  it('removes keys, bearer tokens and Authorization values', () => {
    expect(redactSecrets('failed with Bearer sk-or-v1-abcdef123456')).not.toMatch(/abcdef123456/);
    expect(redactSecrets('key sk-or-v1-abcdef123456 leaked')).toBe('key sk-or-[redacted] leaked');
    expect(redactSecrets('{"Authorization":"Bearer abc.def-ghi"}')).not.toContain('abc.def');
    expect(redactSecrets('exact secret-value-123 here', 'secret-value-123')).toBe('exact [redacted] here');
    expect(redactHeaders({ Authorization: 'Bearer x', 'X-Title': 'App' })).toEqual({ Authorization: '[redacted]', 'X-Title': 'App' });
  });
});
