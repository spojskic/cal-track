import { Stack } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { mealTypeFromGroupName, runTextPipeline, STAGE_LABEL, type MealResult } from '@/ai/meal-pipeline';
import { useAiBootstrap } from '@/ai/use-ai-bootstrap';
import { useAiClient } from '@/ai/use-ai-client';
import { useAiGate } from '@/ai/use-ai-gate';
import { useAiRun } from '@/ai/use-ai-run';
import { Notice } from '@/components/ai/AiBits';
import { AiErrorPanel, AiNotAvailable, AiWorking, openAiSettings } from '@/components/ai/AiPanels';
import { MealReview } from '@/components/ai/MealReview';
import { MealGroupChips, useMealGroupChoice } from '@/components/food/meal-group-chips';
import { TextField } from '@/components/forms';
import { AppText, Button, Card, Screen } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

const EXAMPLES = [
  '200 g chicken breast, 1 cup of rice, 1 tbsp olive oil',
  '2 eggs, 2 slices of toast, coffee with milk',
  'A bowl of oatmeal with a banana and a spoon of peanut butter',
];

export default function DescribeMealScreen() {
  useAiBootstrap();
  const gate = useAiGate();
  const handle = useAiClient();
  const { colors, radius } = useTheme();
  const meal = useMealGroupChoice(undefined);
  const [text, setText] = useState('');
  const [runId, setRunId] = useState(0);
  const run = useAiRun<MealResult>();

  function analyse() {
    if (!handle || text.trim().length === 0) return;
    const input = text.trim();
    const mealHint = mealTypeFromGroupName(meal.mealGroupName);
    void run.run(({ signal, setLabel }) =>
      runTextPipeline({
        handle,
        text: input,
        mealHint,
        signal,
        onStage: (stage) => setLabel(STAGE_LABEL[stage]),
      }),
    );
  }

  function startOver() {
    run.reset();
    setText('');
    setRunId((n) => n + 1);
  }

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: true, title: 'Describe a meal' }} />

      {!gate.enabled || !handle ? (
        <AiNotAvailable reason={gate.reason} />
      ) : run.stage === 'working' ? (
        <AiWorking label={run.label || 'Working...'} onCancel={run.cancel} />
      ) : run.stage === 'done' && run.result ? (
        <MealReview
          key={runId}
          initialItems={run.result.items}
          source="ai_text"
          notes={run.result.meal.notes}
          estimateFailed={run.result.estimateFailed}
          initialMealGroupId={meal.mealGroupId}
          onStartOver={startOver}
        />
      ) : (
        <>
          {run.stage === 'error' && run.error ? (
            <AiErrorPanel error={run.error} onRetry={text.trim() ? analyse : undefined} />
          ) : null}

          <Card>
            <AppText variant="heading">What did you eat?</AppText>
            <TextField
              label="Describe your meal"
              value={text}
              onChangeText={setText}
              placeholder="e.g. 200 g chicken breast, 1 cup of rice, 1 tbsp olive oil"
              multiline
              maxLength={2000}
              autoCapitalize="sentences"
              hint="Write it in your own words and language. Amounts help; the AI estimates what you leave out."
              style={styles.textBox}
            />
            <View style={styles.examples} accessibilityRole="list">
              <AppText variant="label" muted>Examples</AppText>
              {EXAMPLES.map((example) => (
                <Pressable
                  key={example}
                  accessibilityRole="button"
                  accessibilityLabel={`Use example: ${example}`}
                  onPress={() => setText(example)}
                  style={({ pressed }) => [
                    styles.example,
                    { backgroundColor: colors.surfaceAlt, borderColor: colors.border, borderRadius: radius.md, opacity: pressed ? 0.7 : 1 },
                  ]}>
                  <Text style={{ color: colors.text, fontSize: 14 }}>{example}</Text>
                </Pressable>
              ))}
            </View>
          </Card>

          <Card>
            <AppText variant="heading">Meal</AppText>
            {meal.groups.length > 0 ? (
              <MealGroupChips groups={meal.groups} value={meal.mealGroupId} onChange={meal.setMealGroupId} />
            ) : (
              <AppText variant="small" muted>Loading meal groups...</AppText>
            )}
            <Button label="Analyse" onPress={analyse} disabled={text.trim().length === 0} />
          </Card>

          <Notice>
            What you type is sent only to OpenRouter and the model provider you chose, never to Ration. You
            review everything before it is added.
          </Notice>
          <Button label="AI settings and model" variant="ghost" onPress={openAiSettings} />
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  textBox: { minHeight: 120, paddingTop: spacing.sm, textAlignVertical: 'top' },
  examples: { gap: spacing.sm },
  example: {
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 40,
    justifyContent: 'center',
  },
});
