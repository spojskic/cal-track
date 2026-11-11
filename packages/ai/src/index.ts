/**
 * @ration/ai - bring-your-own-key AI layer (OpenRouter), client side only.
 *
 * Typical wiring in the app:
 *
 *   const client = createOpenRouterClient({ apiKey, fetch: expoFetch, appTitle: 'Ration' });
 *   const check  = await validateKey(client);                    // GET /key
 *   const models = await client.listModels({ imageInput: true, structuredOutputs: true, sort: 'newest' });
 *   const model  = pickDefaultVisionModel(models);
 *   const gate   = computeAiGate({ apiKeyPresent: true, keyStatus: keyStatusFromValidation(check), model });
 *   if (!gate.enabled) hide ALL AI UI.
 *
 *   const meal    = await parseMealFromImage({ client, model: model.id, imageBase64, mimeType: 'image/jpeg' });
 *   const matched = await matchItems(meal.items, { searchFoods });  // nutrients come from our DB
 *   const guesses = await estimateMissing({ client, model: model.id, items: matched }); // flag "AI estimate"
 *
 *   const turn = await runCoachTurn({ client, model, history, userMessage, summary, onDelta });
 *
 *   const label = await runLabelPipeline({ client, model: model.id, imageBase64, mimeType: 'image/jpeg' });
 *   const draft = labelToFoodDraft(label);                          // @ration/core: the values for the new-food form
 */

export * from './errors';
export * from './types';
export * from './sse';
export * from './json-schema';
export * from './image';
export * from './openrouter';
export * from './pkce';
export * from './oauth-flow';
export * from './gate';
export * from './schemas';
export * from './prompts';
export * from './similarity';
export * from './pipeline';
export * from './label';
export * from './food-candidate';
export * from './error-presentation';
export * from './coach';
export * from './coach-findings';
