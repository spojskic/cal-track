import { EXERCISE_CATEGORIES, searchActivities, type MetActivity } from '@ration/core';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { TextField } from '@/components/forms';
import { AppText, Card } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

import { Chip } from './chips';
import { trimNum } from './format';

const RESULT_LIMIT = 40;

/** Searchable MET activity list with category shortcuts. Collapses to a summary once chosen. */
export function ActivityPicker({
  value,
  onChange,
}: {
  value: MetActivity | null;
  onChange: (activity: MetActivity | null) => void;
}) {
  const { colors, radius } = useTheme();
  const [query, setQuery] = useState('');
  const results = useMemo(() => searchActivities(query, query.trim() ? RESULT_LIMIT : 25), [query]);

  if (value) {
    return (
      <Card style={styles.selected}>
        <View style={{ flex: 1 }}>
          <AppText variant="heading">{value.name}</AppText>
          <AppText variant="small" muted>
            {value.category} - {trimNum(value.met, 1)} MET
          </AppText>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Change activity"
          onPress={() => onChange(null)}
          hitSlop={8}
          style={styles.change}>
          <AppText variant="small" style={{ color: colors.accent, fontWeight: '700' }}>Change</AppText>
        </Pressable>
      </Card>
    );
  }

  const q = query.trim().toLowerCase();
  return (
    <View style={styles.wrap}>
      <TextField
        label="Activity"
        value={query}
        onChangeText={setQuery}
        placeholder="Search, e.g. running, yoga, cycling"
        autoCorrect={false}
        returnKeyType="search"
        clearButtonMode="while-editing"
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.categories}>
        {EXERCISE_CATEGORIES.map((c) => {
          const selected = q === c.toLowerCase();
          return <Chip key={c} label={c} selected={selected} onPress={() => setQuery(selected ? '' : c)} />;
        })}
      </ScrollView>
      <Card style={styles.list}>
        {results.length === 0 ? (
          <AppText muted style={styles.empty}>
            No matching activity. Try another word or use Custom exercise.
          </AppText>
        ) : (
          results.map((a) => (
            <Pressable
              key={a.code}
              accessibilityRole="button"
              accessibilityLabel={`${a.name}, ${trimNum(a.met, 1)} MET`}
              onPress={() => onChange(a)}
              style={({ pressed }) => [
                styles.row,
                { backgroundColor: pressed ? colors.surfaceAlt : 'transparent', borderRadius: radius.md },
              ]}>
              <View style={{ flex: 1 }}>
                <AppText variant="body" style={{ fontWeight: '600' }}>{a.name}</AppText>
                <AppText variant="small" muted>{a.category}</AppText>
              </View>
              <AppText variant="small" muted>{trimNum(a.met, 1)} MET</AppText>
            </Pressable>
          ))
        )}
        {results.length >= (q ? RESULT_LIMIT : 25) ? (
          <AppText variant="small" muted style={styles.empty}>
            {q ? 'Refine your search to narrow the list.' : 'Search or pick a category to see more.'}
          </AppText>
        ) : null}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.md },
  categories: { gap: spacing.sm, paddingVertical: spacing.xs },
  list: { padding: spacing.xs, gap: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 52,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  empty: { padding: spacing.md },
  selected: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  change: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.sm },
});
