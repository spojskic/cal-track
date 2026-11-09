import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui';
import { spacing } from '@/theme';

import { FoodPicker } from './FoodPicker';
import { ReviewItemCard } from './ReviewItemCard';
import { manualItem, type ReviewItem } from './review-model';

/**
 * The list of identified items with per-item editing, plus "Add another food". Controlled: the parent owns
 * the items so it can total them and write them to the diary / recipe.
 */
export function ReviewItemsEditor({
  items,
  onChange,
  errors,
}: {
  items: ReviewItem[];
  onChange: (items: ReviewItem[]) => void;
  /** Per-item error messages by item key. */
  errors?: Record<string, string | undefined>;
}) {
  const [adding, setAdding] = useState(false);

  function patch(key: string, change: Partial<ReviewItem>) {
    onChange(items.map((it) => (it.key === key ? { ...it, ...change } : it)));
  }

  return (
    <View style={styles.list}>
      {items.map((item) => (
        <ReviewItemCard
          key={item.key}
          item={item}
          error={errors?.[item.key]}
          onChange={(change) => patch(item.key, change)}
          onRemove={() => onChange(items.filter((it) => it.key !== item.key))}
        />
      ))}
      {adding ? (
        <FoodPicker
          title="Add a missing food"
          onPick={(food) => {
            onChange([...items, manualItem(food)]);
            setAdding(false);
          }}
          onClose={() => setAdding(false)}
        />
      ) : (
        <Button label="Add a missing food" variant="secondary" onPress={() => setAdding(true)} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.md },
});
