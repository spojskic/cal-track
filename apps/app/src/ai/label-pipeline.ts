import { runLabelPipeline, type LabelReading } from '@cal/ai';
import { labelToFoodDraft, type LabelFoodDraft } from '@cal/core';

import type { PreparedImage } from './image';
import type { AiClientHandle } from './use-ai-client';

/**
 * Photo of a nutrition label -> the values of the new-food form. One vision request through the user's own OpenRouter
 * key; the conversion to catalog units (kJ -> kcal, salt -> sodium, basis, carbohydrate basis, checks) happens on the
 * device in @cal/core. Nothing is saved: the form shows the draft for review.
 */

export const LABEL_STAGE = 'Reading the nutrition label...';

export interface LabelScanResult {
  reading: LabelReading;
  draft: LabelFoodDraft;
}

export async function runLabelScan(args: {
  handle: AiClientHandle;
  image: PreparedImage;
  signal?: AbortSignal;
}): Promise<LabelScanResult> {
  const reading = await runLabelPipeline({
    client: args.handle.client,
    model: args.handle.modelId,
    imageBase64: args.image.base64,
    mimeType: args.image.mimeType,
    signal: args.signal,
  });
  // defaultCarbBasis is the app's default ('includes_fiber'), used only when the label does not say (and it is flagged).
  return { reading, draft: labelToFoodDraft(reading) };
}
