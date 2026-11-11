import { parseNumber } from '@cal/core';
import { router, Stack, type Href } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { runRecipePipeline, STAGE_LABEL, type RecipeResult } from '@/ai/meal-pipeline';
import { useAiBootstrap } from '@/ai/use-ai-bootstrap';
import { useAiClient } from '@/ai/use-ai-client';
import { useAiGate } from '@/ai/use-ai-gate';
import { useAiRun } from '@/ai/use-ai-run';
import { Notice } from '@/components/ai/AiBits';
import { AiErrorPanel, AiNotAvailable, AiWorking, openAiSettings } from '@/components/ai/AiPanels';
import { AI_DISCLAIMER } from '@/components/ai/MealReview';
import { nutrientLine } from '@/components/ai/ReviewItemCard';
import { ReviewItemsEditor } from '@/components/ai/ReviewItemsEditor';
import {
  estimateFoodName,
  isAiEstimateItem,
  isItemReady,
  itemGrams,
  summaryForNewEstimate,
  sumReviewItems,
  type ReviewItem,
} from '@/components/ai/review-model';
import { hapticSuccess } from '@/components/food/feedback';
import { NumberField, TextField } from '@/components/forms';
import { AppText, Button, Card, Screen } from '@/components/ui';
import { createAiEstimateFood } from '@/data/ai-foods';
import { errorMessage } from '@/data/foods';
import { useCreateRecipe } from '@/data/recipes';
import { spacing } from '@/theme';

const PLACEHOLDER =
  'Chicken and potato stew, 4 servings. 600 g chicken thighs, 400 g potatoes, 1 onion, 2 tbsp olive oil, salt. Cooked weight about 1400 g.';

export default function AiRecipeScreen() {
  useAiBootstrap();
  const gate = useAiGate();
  const handle = useAiClient();
  const [text, setText] = useState('');
  const run = useAiRun<RecipeResult>();
  const [runId, setRunId] = useState(0);

  function draft() {
    if (!handle || text.trim().length === 0) return;
    const input = text.trim();
    void run.run(({ signal, setLabel }) =>
      runRecipePipeline({ handle, text: input, signal, onStage: (stage) => setLabel(STAGE_LABEL[stage]) }),
    );
  }

  function startOver() {
    run.reset();
    setRunId((n) => n + 1);
  }

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: true, title: 'Recipe from text' }} />

      {!gate.enabled || !handle ? (
        <AiNotAvailable reason={gate.reason} />
      ) : run.stage === 'working' ? (
        <AiWorking label={run.label || 'Working...'} onCancel={run.cancel} />
      ) : run.stage === 'done' && run.result ? (
        <RecipeDraftReview key={runId} result={run.result} onStartOver={startOver} />
      ) : (
        <>
          {run.stage === 'error' && run.error ? (
            <AiErrorPanel error={run.error} onRetry={text.trim() ? draft : undefined} />
          ) : null}
          <Card>
            <AppText variant="heading">Describe your recipe</AppText>
            <TextField
              label="Ingredients, servings and cooked weight"
              value={text}
              onChangeText={setText}
              placeholder={PLACEHOLDER}
              multiline
              maxLength={6000}
              autoCapitalize="sentences"
              hint="Include amounts, how many servings it makes and, if you weighed it, the cooked weight."
              style={styles.textBox}
            />
            <Button label="Draft recipe" onPress={draft} disabled={text.trim().length === 0} />
          </Card>
          <Notice>
            What you type is sent only to OpenRouter and the model provider you chose, never to Ration. Nutrition
            comes from the food database; you review every ingredient before the recipe is created.
          </Notice>
          <Button label="AI settings and model" variant="ghost" onPress={openAiSettings} />
        </>
      )}
    </Screen>
  );
}

function RecipeDraftReview({ result, onStartOver }: { result: RecipeResult; onStartOver: () => void }) {
  const createRecipe = useCreateRecipe();
  const [items, setItems] = useState<ReviewItem[]>(result.items);
  const [name, setName] = useState(result.draft.name);
  const [servingsText, setServingsText] = useState(String(result.draft.servings));
  const [weightText, setWeightText] = useState(
    result.draft.finalWeightG !== undefined ? String(Math.round(result.draft.finalWeightG)) : '',
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const servings = parseNumber(servingsText);
  const weight = weightText.trim() === '' ? null : parseNumber(weightText);
  const { totals, incomplete } = sumReviewItems(items);
  const perServing = servings && servings > 0 ? scaleKcalLine(items, servings) : null;
  const blocked = items.filter((i) => !isItemReady(i)).length;
  const problem =
    name.trim() === ''
      ? 'Give the recipe a name.'
      : !servings || servings <= 0
        ? 'Enter how many servings the recipe makes.'
        : weight !== null && weight <= 0
          ? 'Cooked weight must be more than 0 g (or leave it empty).'
          : items.length === 0
            ? 'Add at least one ingredient.'
            : blocked > 0
              ? `${blocked} ${blocked === 1 ? 'ingredient needs' : 'ingredients need'} a food and an amount, or remove ${blocked === 1 ? 'it' : 'them'}.`
              : null;

  async function create() {
    if (problem || !servings || saving) return;
    setSaving(true);
    setError(null);
    try {
      const working = [...items];
      const estimated: string[] = [];
      const ingredients: { foodId: string; grams: number }[] = [];
      for (let i = 0; i < working.length; i++) {
        const item = working[i] as ReviewItem;
        if (item.choice.kind === 'food') {
          if (item.choice.food.source === 'ai_estimate') estimated.push(item.choice.food.name);
          ingredients.push({ foodId: item.choice.food.id, grams: itemGrams(item) });
        } else if (item.choice.kind === 'estimate' && item.estimate) {
          const foodName = estimateFoodName(item);
          const created = await createAiEstimateFood({ name: foodName, estimate: item.estimate });
          estimated.push(foodName);
          ingredients.push({ foodId: created.id, grams: itemGrams(item) });
          // Remember the saved food so a retry after a later failure does not create it twice.
          setItems((prev) =>
            prev.map((it) =>
              it.key === item.key ? { ...it, choice: { kind: 'food', food: summaryForNewEstimate(created.id, item) } } : it,
            ),
          );
        }
      }
      const notes = [
        result.draft.instructions?.trim(),
        estimated.length > 0
          ? `Contains AI-estimated nutrition (not verified) for: ${[...new Set(estimated)].join(', ')}.`
          : undefined,
      ]
        .filter(Boolean)
        .join('\n\n');
      const created = await createRecipe.mutateAsync({
        name: name.trim(),
        servings,
        finalWeightG: weight,
        notes: notes || undefined,
        ingredients,
      });
      hapticSuccess();
      router.replace({ pathname: '/recipe/[id]', params: { id: created.foodId } } as unknown as Href);
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  }

  return (
    <View style={styles.stack}>
      <Notice tone="warning">{AI_DISCLAIMER}</Notice>
      {result.estimateFailed ? (
        <Notice tone="warning">
          The AI could not estimate nutrition for some ingredients that are not in the database. Choose a food for them or remove them.
        </Notice>
      ) : null}

      <Card>
        <AppText variant="heading">Recipe</AppText>
        <TextField label="Name" value={name} onChangeText={setName} maxLength={120} />
        <NumberField label="Servings" value={servingsText} onChange={setServingsText} />
        <NumberField
          label="Cooked weight"
          unit="g"
          value={weightText}
          onChange={setWeightText}
          hint="Optional. Weigh the finished dish to get accurate values per 100 g."
        />
      </Card>

      <AppText variant="heading">Ingredients</AppText>
      <ReviewItemsEditor items={items} onChange={setItems} />

      <Card>
        <AppText variant="heading">Nutrition</AppText>
        <AppText variant="small" muted>Whole recipe</AppText>
        <AppText style={styles.bold}>{nutrientLine(totals)}</AppText>
        {perServing ? (
          <>
            <AppText variant="small" muted>Per serving</AppText>
            <AppText style={styles.bold}>{perServing}</AppText>
          </>
        ) : null}
        {items.some(isAiEstimateItem) ? (
          <AppText variant="small" muted>Includes AI-estimated nutrition (not verified).</AppText>
        ) : null}
        {incomplete ? <AppText variant="small" muted>Some ingredients have no nutrition data.</AppText> : null}
      </Card>

      {problem ? <Notice tone="danger">{problem}</Notice> : null}
      {error ? <Notice tone="danger" live>{error}</Notice> : null}
      <Button label="Create recipe" onPress={create} loading={saving} disabled={Boolean(problem)} />
      <Button label="Start over" variant="ghost" onPress={onStartOver} disabled={saving} />
    </View>
  );
}

function scaleKcalLine(items: ReviewItem[], servings: number): string {
  const { totals } = sumReviewItems(items);
  const div = (v: number | undefined) => (v === undefined ? undefined : v / servings);
  return nutrientLine({
    ENERGY_KCAL: div(totals.ENERGY_KCAL),
    PROTEIN_G: div(totals.PROTEIN_G),
    CARBS_G: div(totals.CARBS_G),
    FAT_G: div(totals.FAT_G),
  });
}

const styles = StyleSheet.create({
  stack: { gap: spacing.md },
  textBox: { minHeight: 140, paddingTop: spacing.sm, textAlignVertical: 'top' },
  bold: { fontWeight: '700' },
});
