import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { leaveAiFlow } from '@/ai/navigation';
import { hapticSuccess } from '@/components/food/feedback';
import { formatDayLabel } from '@/components/food/format';
import { DayStepper } from '@/components/food/day-stepper';
import { MealGroupChips, useMealGroupChoice } from '@/components/food/meal-group-chips';
import { AppText, Button, Card } from '@/components/ui';
import { useCreateAiEstimateFood } from '@/data/ai-foods';
import { useAddDiaryEntry, type DiarySource } from '@/data/diary-write';
import { errorMessage } from '@/data/foods';
import { useSelectedDate } from '@/state/selected-date';
import { spacing } from '@/theme';

import { Notice } from './AiBits';
import { ReviewItemsEditor } from './ReviewItemsEditor';
import { nutrientLine } from './ReviewItemCard';
import {
  estimateFoodName,
  isAiEstimateItem,
  isItemReady,
  itemGrams,
  itemStoredConfidence,
  summaryForNewEstimate,
  sumReviewItems,
  type ReviewItem,
} from './review-model';

export const AI_DISCLAIMER = 'AI estimates can be wrong - check portions.';

/**
 * Shared review step for Photo log and Describe-a-meal. The AI identified foods and amounts; nutrition
 * comes from the food database (items that had no match carry a flagged AI estimate). Nothing is written
 * until the user taps "Add all to diary".
 */
export function MealReview({
  initialItems,
  source,
  notes,
  estimateFailed,
  initialMealGroupId,
  onStartOver,
}: {
  initialItems: ReviewItem[];
  source: Extract<DiarySource, 'ai_photo' | 'ai_text'>;
  /** The AI's own note about what was unclear or assumed. */
  notes?: string;
  /** Estimating nutrition for unmatched foods failed: those items need a manual choice. */
  estimateFailed?: boolean;
  initialMealGroupId?: string;
  onStartOver?: () => void;
}) {
  const date = useSelectedDate((s) => s.date);
  const meal = useMealGroupChoice(initialMealGroupId);
  const addEntry = useAddDiaryEntry();
  const createFood = useCreateAiEstimateFood();

  const [items, setItems] = useState<ReviewItem[]>(initialItems);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [summary, setSummary] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const pending = items.filter((i) => !i.added);
  const ready = pending.filter(isItemReady);
  const blocked = pending.length - ready.length;
  const { totals, incomplete } = sumReviewItems(items);
  const anyEstimate = items.some(isAiEstimateItem);
  const canAdd = ready.length > 0 && blocked === 0 && Boolean(meal.mealGroupId) && !adding;

  function update(next: ReviewItem[]) {
    setItems(next);
    setSummary(null);
  }

  function patchItem(key: string, change: Partial<ReviewItem>) {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...change } : it)));
  }

  async function addAll() {
    const mealGroupId = meal.mealGroupId;
    if (!mealGroupId || adding) return;
    setAdding(true);
    setSummary(null);
    setErrors({});
    let failed = 0;
    let added = 0;
    for (const item of ready) {
      try {
        let foodId: string;
        if (item.choice.kind === 'food') {
          foodId = item.choice.food.id;
        } else if (item.choice.kind === 'estimate' && item.estimate) {
          const created = await createFood.mutateAsync({ name: estimateFoodName(item), estimate: item.estimate });
          foodId = created.id;
          // Remember the saved food so a retry after a later failure does not create it twice.
          patchItem(item.key, { choice: { kind: 'food', food: summaryForNewEstimate(created.id, item) } });
        } else {
          continue;
        }
        const grams = itemGrams(item);
        await addEntry.mutateAsync({
          foodId,
          grams,
          amount: grams,
          portionLabel: 'g',
          mealGroupId,
          entryDate: date,
          source,
          aiConfidence: itemStoredConfidence(item),
        });
        patchItem(item.key, { added: true });
        added += 1;
      } catch (e) {
        failed += 1;
        setErrors((prev) => ({ ...prev, [item.key]: errorMessage(e) }));
      }
    }
    setAdding(false);
    if (failed === 0) {
      hapticSuccess();
      leaveAiFlow();
      return;
    }
    setSummary(
      `Added ${added} of ${added + failed} items. Fix the items marked in red and press the button again - the ones already added will not be duplicated.`,
    );
  }

  const label =
    ready.length === 1 ? 'Add 1 item to diary' : `Add all to diary (${ready.length})`;

  return (
    <View style={styles.root}>
      <Notice tone="warning">{AI_DISCLAIMER}</Notice>
      {notes ? <Notice>{`AI note: ${notes}`}</Notice> : null}
      {estimateFailed ? (
        <Notice tone="warning">
          The AI could not estimate nutrition for foods that are not in the database. Choose a food for those items or remove them.
        </Notice>
      ) : null}

      <ReviewItemsEditor items={items} onChange={update} errors={errors} />

      <Card>
        <AppText variant="heading">Destination</AppText>
        <DayStepper />
        {meal.groups.length > 0 ? (
          <MealGroupChips groups={meal.groups} value={meal.mealGroupId} onChange={meal.setMealGroupId} />
        ) : (
          <AppText variant="small" muted>Loading meal groups...</AppText>
        )}
        <AppText variant="small" muted>
          Adding to {meal.mealGroupName ?? 'your diary'} {'\u00B7'} {formatDayLabel(date)}
        </AppText>
      </Card>

      <Card>
        <AppText variant="heading">Total</AppText>
        <AppText variant="body" style={styles.total} accessibilityLabel={`Total: ${nutrientLine(totals).replace(/\|/g, ',')}`}>
          {nutrientLine(totals)}
        </AppText>
        {anyEstimate ? (
          <AppText variant="small" muted>Includes AI-estimated nutrition (not verified).</AppText>
        ) : null}
        {incomplete ? (
          <AppText variant="small" muted>Some items have no nutrition data, so the total is a lower bound.</AppText>
        ) : null}
      </Card>

      {blocked > 0 ? (
        <Notice tone="danger" live>
          {`${blocked} ${blocked === 1 ? 'item needs' : 'items need'} a food and an amount. Fix ${blocked === 1 ? 'it' : 'them'} or remove ${blocked === 1 ? 'it' : 'them'} to continue.`}
        </Notice>
      ) : null}
      {summary ? <Notice tone="danger" live>{summary}</Notice> : null}

      <Button label={label} onPress={addAll} loading={adding} disabled={!canAdd} />
      {onStartOver ? <Button label="Start over" variant="ghost" onPress={onStartOver} disabled={adding} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.md },
  total: { fontWeight: '700' },
});
