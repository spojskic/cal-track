import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { rememberSummaries } from '@/ai/search-adapter';
import { Glyph } from '@/components/Glyph';
import { FoodRow } from '@/components/food/food-row';
import { useDebouncedValue } from '@/components/food/use-debounced-value';
import { AppText } from '@/components/ui';
import { errorMessage, useFoodSearch, type FoodSummary } from '@/data/foods';
import { radius, spacing, useTheme } from '@/theme';

/**
 * Inline food picker: suggested alternatives first, then the same server-side search the Search screen
 * uses. Picking a row calls `onPick`; the parent decides what that means (swap a match, add an item).
 */
export function FoodPicker({
  title,
  suggestions = [],
  initialQuery = '',
  onPick,
  onClose,
}: {
  title: string;
  suggestions?: FoodSummary[];
  initialQuery?: string;
  onPick: (food: FoodSummary) => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const [query, setQuery] = useState(initialQuery);
  const debounced = useDebouncedValue(query, 250);
  const trimmed = debounced.trim();
  const search = useFoodSearch(trimmed);
  const searching = trimmed.length >= 2;
  const rows = searching ? (search.data ?? []) : suggestions;

  function pick(food: FoodSummary) {
    rememberSummaries([food]);
    onPick(food);
  }

  return (
    <View style={[styles.panel, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
      <View style={styles.header}>
        <AppText variant="body" style={styles.title}>{title}</AppText>
        <Pressable accessibilityRole="button" accessibilityLabel="Close food search" onPress={onClose} hitSlop={8}>
          <Glyph name="close" size={18} color={colors.textMuted} />
        </Pressable>
      </View>
      <View style={[styles.searchBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search foods, e.g. chicken breast"
          placeholderTextColor={colors.textMuted}
          accessibilityLabel="Search foods"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={[styles.input, { color: colors.text }]}
        />
        {searching && search.isFetching ? <ActivityIndicator color={colors.textMuted} accessibilityLabel="Searching" /> : null}
      </View>
      {!searching && suggestions.length > 0 ? (
        <AppText variant="label" muted>Suggested matches</AppText>
      ) : null}
      {search.error && searching ? (
        <AppText variant="small" style={{ color: colors.danger }}>{errorMessage(search.error)}</AppText>
      ) : null}
      <View style={styles.list}>
        {rows.slice(0, 12).map((food) => (
          <FoodRow key={food.id} food={food} onPress={() => pick(food)} />
        ))}
        {rows.length === 0 ? (
          <AppText variant="small" muted>
            {searching ? (search.isLoading ? 'Searching...' : 'No foods found. Try other words.') : 'Type at least 2 letters to search.'}
          </AppText>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: spacing.md, gap: spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  title: { fontWeight: '700', flex: 1 },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    minHeight: 44,
    gap: spacing.sm,
  },
  input: { flex: 1, fontSize: 16, minHeight: 42 },
  list: { gap: spacing.sm },
});
