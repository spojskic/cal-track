import { ScrollView, StyleSheet, View } from 'react-native';

import { Chip } from '@/components/settings/rows';
import { spacing } from '@/theme';

export interface ChipItem<K extends string> {
  key: K;
  label: string;
}

/** A single row of filter chips that scrolls sideways when it does not fit (phones). */
export function ChipRow<K extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: readonly ChipItem<K>[];
  value: K;
  onChange: (key: K) => void;
  /** Accessible name of the group ("Filter by source"). */
  label: string;
}) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {items.map((item) => (
          <Chip key={item.key} label={item.label} selected={item.key === value} onPress={() => onChange(item.key)} />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.xs },
});
