/**
 * Nutrition label reading: photo of a "Nutrition Facts" panel -> validated {@link LabelReading}.
 *
 * The model only TRANSCRIBES what is printed (see NUTRITION_LABEL_SYSTEM_PROMPT); this module validates the reply
 * with zod, drops what cannot be trusted (unknown keys, impossible amounts, duplicates) and reports it in `warnings`.
 * Converting the reading into a food (kJ -> kcal, salt -> sodium, units, basis) is `labelToFoodDraft` in @cal/core.
 *
 * Like the other pipelines, nothing here touches the network directly: the OpenRouter client is injected.
 */

import {
  LABEL_BASES,
  LABEL_FIELDS,
  LABEL_NUTRIENTS,
  LABEL_NUTRIENT_KEYS,
  LABEL_UNITS,
  isLabelNutrientKey,
  isPlausibleLabelAmount,
  type LabelBasis,
  type LabelField,
  type LabelNutrientKey,
  type LabelNutrientReading,
  type LabelReading,
  type LabelUnit,
} from '@cal/core';
import { z } from 'zod';

import { NoLabelFoundError } from './errors';
import { assertReasonableImageSize } from './image';
import { toStrictJsonSchema } from './json-schema';
import type { OpenRouterClient } from './openrouter';
import { NUTRITION_LABEL_SYSTEM_PROMPT } from './prompts';

export type { LabelReading } from '@cal/core';

type JsonClient = Pick<OpenRouterClient, 'chatJson'>;

// ---------------------------------------------------------------------------
// wire schema (what the model returns; also the JSON Schema sent to OpenRouter)
// ---------------------------------------------------------------------------

/**
 * A key outside the fixed list does not fail the whole reply (which would cost a repair round trip): it is replaced
 * by this marker at parse time and dropped by {@link sanitizeLabelReading}. Providers with strict structured outputs
 * can never produce one, because the list is an enum in the JSON Schema.
 */
const UNKNOWN_KEY = '__unknown__' as LabelNutrientKey;

const LabelNutrientWireSchema = z.object({
  key: z
    .enum(LABEL_NUTRIENT_KEYS)
    .catch(UNKNOWN_KEY)
    .describe('One of the allowed nutrient keys'),
  amount: z.number().min(0).describe('The number printed on the label for this nutrient, in `unit`. Never a percentage.'),
  unit: z.enum(LABEL_UNITS).describe('The unit printed next to the number: g, mg, mcg (ug/µg), kcal, kj or iu'),
  unclear: z
    .boolean()
    .optional()
    .describe('true if you are not sure you read this value correctly (blurry, cut off, glare, tiny print)'),
});

export const LabelWireSchema = z.object({
  labelFound: z.boolean().describe('false if the photo does not show a nutrition label'),
  productName: z.string().optional().describe('Product name if it is printed in the photo, otherwise null'),
  brand: z.string().optional().describe('Brand if it is printed in the photo, otherwise null'),
  basis: z
    .enum(LABEL_BASES)
    .optional()
    .describe('Which column was transcribed: per_100g, per_100ml or per_serving. null if there is no label.'),
  servingAmount: z.number().min(0).optional().describe('Metric size of ONE serving as printed, e.g. 55. null if not printed.'),
  servingUnit: z.enum(['g', 'ml']).optional().describe('g or ml, the unit of servingAmount'),
  servingText: z.string().optional().describe('Household measure of one serving as printed, e.g. "2/3 cup". null if not printed.'),
  servingsPerContainer: z.number().min(0).optional().describe('Servings per container as printed ("about 8" is 8). null if not printed.'),
  carbohydrateIncludesFibre: z
    .boolean()
    .optional()
    .describe('true if the carbohydrate figure includes fibre (US style), false if fibre is listed separately (EU style), null if unknown'),
  nutrients: z.array(LabelNutrientWireSchema).max(80).describe('Only the nutrients that are printed, one entry each'),
  unclearFields: z.array(z.enum(LABEL_FIELDS)).optional().describe('Fields other than nutrients that you are not sure about'),
  notes: z.string().optional().describe('One or two short sentences about anything the user should check, or null'),
});
export type LabelWire = z.infer<typeof LabelWireSchema>;

/** The JSON Schema (strict mode subset) sent as `response_format`. Exposed for tests and tooling. */
export function labelJsonSchema(): Record<string, unknown> {
  return toStrictJsonSchema(LabelWireSchema);
}

// ---------------------------------------------------------------------------
// sanitising
// ---------------------------------------------------------------------------

const CONTROL_CHARS = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

/** Single line of display text from the model (or the packaging): no control/bidi characters, trimmed, capped. */
function cleanLine(text: string | undefined | null, maxChars: number): string | null {
  const t = (text ?? '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (t === '') return null;
  return t.length > maxChars ? `${t.slice(0, maxChars - 1).trimEnd()}\u2026` : t;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

const UNIT_TEXT: Record<LabelUnit, string> = { kcal: 'kcal', kj: 'kJ', g: 'g', mg: 'mg', mcg: '\u00B5g', iu: 'IU' };

/** Largest serving a package label can plausibly state (g or ml). */
const MAX_SERVING = 5000;
const MAX_SERVINGS_PER_CONTAINER = 1000;

/**
 * Validates and cleans one model reply. Never throws: what cannot be trusted is dropped and listed in `warnings`.
 *  - unknown keys, duplicates (the first stays; it is marked unclear when the second disagrees), non-finite or
 *    negative amounts and amounts that are impossible for their unit and basis are dropped;
 *  - text is trimmed, stripped of control characters and capped; empty text becomes null;
 *  - a missing basis becomes per 100 g, flagged as unclear.
 */
export function sanitizeLabelReading(wire: LabelWire): LabelReading {
  const warnings: string[] = [];
  const unclearFields = new Set<LabelField>(wire.unclearFields ?? []);

  let basis: LabelBasis;
  if (wire.basis !== undefined) {
    basis = wire.basis;
  } else {
    basis = 'per_100g';
    if (wire.nutrients.length > 0) {
      unclearFields.add('basis');
      warnings.push('The label does not say what the values are per. Per 100 g was assumed; check it.');
    }
  }

  const nutrients: LabelNutrientReading[] = [];
  const byKey = new Map<LabelNutrientKey, LabelNutrientReading>();
  let unknown = 0;
  for (const entry of wire.nutrients) {
    if (!isLabelNutrientKey(entry.key)) {
      unknown += 1;
      continue;
    }
    const name = LABEL_NUTRIENTS[entry.key].name;
    if (!isPlausibleLabelAmount(entry.amount, entry.unit, basis)) {
      warnings.push(`${name} (${round4(entry.amount)} ${UNIT_TEXT[entry.unit]}) does not look right for this label and was left out.`);
      continue;
    }
    const amount = round4(entry.amount);
    const earlier = byKey.get(entry.key);
    if (earlier) {
      // The same nutrient twice (two columns, two languages): keep the first, but a disagreement means "check it".
      if (earlier.unit !== entry.unit || Math.abs(earlier.amount - amount) > 0.01 * Math.max(earlier.amount, amount)) {
        earlier.unclear = true;
      }
      continue;
    }
    const reading: LabelNutrientReading = { key: entry.key, amount, unit: entry.unit, unclear: entry.unclear === true };
    byKey.set(entry.key, reading);
    nutrients.push(reading);
  }
  if (unknown > 0) warnings.push(`${unknown} value${unknown === 1 ? '' : 's'} on the label ${unknown === 1 ? 'is' : 'are'} not supported and ${unknown === 1 ? 'was' : 'were'} skipped.`);

  const servingAmount =
    wire.servingAmount !== undefined && Number.isFinite(wire.servingAmount) && wire.servingAmount > 0 && wire.servingAmount <= MAX_SERVING
      ? round4(wire.servingAmount)
      : null;
  const servingsPerContainer =
    wire.servingsPerContainer !== undefined &&
    Number.isFinite(wire.servingsPerContainer) &&
    wire.servingsPerContainer > 0 &&
    wire.servingsPerContainer <= MAX_SERVINGS_PER_CONTAINER
      ? round4(wire.servingsPerContainer)
      : null;

  return {
    productName: cleanLine(wire.productName, 120),
    brand: cleanLine(wire.brand, 80),
    basis,
    serving: {
      amount: servingAmount,
      unit: servingAmount === null ? null : (wire.servingUnit ?? null),
      text: cleanLine(wire.servingText, 60),
    },
    servingsPerContainer,
    carbohydrateIncludesFibre: wire.carbohydrateIncludesFibre ?? null,
    nutrients,
    unclearFields: LABEL_FIELDS.filter((f) => unclearFields.has(f)),
    notes: cleanLine(wire.notes, 400),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// pipeline
// ---------------------------------------------------------------------------

export interface RunLabelPipelineArgs {
  client: JsonClient;
  /** Primary model id (must accept image input). */
  model: string;
  /** Optional fallback models, tried in order by OpenRouter. */
  fallbackModels?: string[];
  /** Base64 JPEG/PNG/WebP, already resized (~1024 px) by the app. A data: prefix is tolerated. */
  imageBase64: string;
  mimeType: string;
  signal?: AbortSignal;
  maxTokens?: number;
}

/**
 * Reads the nutrition label in a photo through the user's own OpenRouter key.
 *
 * - The reply is validated against {@link LabelWireSchema}; invalid JSON or a schema mismatch is repaired with one
 *   retry by the client (see `chatJson`), a hard refusal surfaces as an OpenRouterError of kind `moderation`.
 * - Throws {@link NoLabelFoundError} when the photo shows no label or nothing usable could be read from it.
 * - Aborting `signal` aborts the request (AbortError).
 */
export async function runLabelPipeline(args: RunLabelPipelineArgs): Promise<LabelReading> {
  assertReasonableImageSize(args.imageBase64);
  const wire = await args.client.chatJson({
    model: args.model,
    models: args.fallbackModels,
    schema: LabelWireSchema,
    jsonSchemaName: 'nutrition_label',
    // A transcription: no creativity wanted.
    temperature: 0,
    maxTokens: args.maxTokens ?? 2500,
    signal: args.signal,
    images: [{ base64: args.imageBase64, mimeType: args.mimeType }],
    messages: [
      { role: 'system', content: NUTRITION_LABEL_SYSTEM_PROMPT },
      { role: 'user', content: 'Transcribe the nutrition label in the attached photo.' },
    ],
  });
  if (!wire.labelFound) throw new NoLabelFoundError();
  const reading = sanitizeLabelReading(wire);
  if (reading.nutrients.length === 0) throw new NoLabelFoundError();
  return reading;
}
