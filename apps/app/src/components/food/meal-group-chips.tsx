import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { defaultMealGroupId, useMealGroups, type MealGroup } from '@/data/meal-groups';
import { radius, spacing, useTheme } from '@/theme';

/** Wrapping chip row to pick a meal group. */
export function MealGroupChips({
  groups,
  value,
  onChange,
}: {
  groups: MealGroup[];
  value: string | undefined;
  onChange: (id: string) => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.row} accessibilityRole="radiogroup">
      {groups.map((g) => {
        const selected = g.id === value;
        return (
          <Pressable
            key={g.id}
            accessibilityRole="radio"
            accessibilityLabel={g.name}
            accessibilityState={{ selected }}
            onPress={() => onChange(g.id)}
            style={[
              styles.chip,
              {
                backgroundColor: selected ? colors.primary : colors.surfaceAlt,
                borderColor: selected ? colors.primary : colors.border,
              },
            ]}>
            <Text style={[styles.label, { color: selected ? colors.onPrimary : colors.text }]}>{g.name}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Meal group selection state: starts at `initialId` (route param) or the time-of-day default,
 * until the user picks another one.
 */
export function useMealGroupChoice(initialId: string | undefined) {
  const groupsQuery = useMealGroups();
  const [picked, setPicked] = useState<string | undefined>(initialId);
  const all = groupsQuery.data ?? [];
  const visible = all.filter((g) => !g.hidden || g.id === picked);
  const mealGroupId = picked ?? defaultMealGroupId(all);
  const selected = all.find((g) => g.id === mealGroupId);
  return {
    isLoading: groupsQuery.isLoading,
    groups: visible,
    mealGroupId,
    mealGroupName: selected?.name,
    setMealGroupId: setPicked,
  };
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    minHeight: 36,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { fontSize: 14, fontWeight: '600' },
});
