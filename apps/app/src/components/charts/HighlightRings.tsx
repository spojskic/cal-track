import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/ui';
import { spacing } from '@/theme';

import { ProgressRing } from './ProgressRing';

export interface HighlightRingItem {
  key: string;
  label: string;
  /** Intake / target (1 = 100%); 0 when unknown. */
  fraction: number;
  /** Text in the ring, e.g. "74%" or "-". */
  text: string;
  color: string;
  overColor?: string;
}

/** Wrapping grid of small rings (highlighted nutrients). */
export function HighlightRings({ items, size = 60 }: { items: HighlightRingItem[]; size?: number }) {
  return (
    <View style={styles.grid}>
      {items.map((item) => (
        <View
          key={item.key}
          accessible
          accessibilityLabel={`${item.label}: ${item.text === '-' ? 'no data' : item.text}`}
          style={styles.cell}>
          <ProgressRing
            value={item.fraction}
            size={size}
            strokeWidth={6}
            color={item.color}
            overColor={item.overColor}
            label={item.text}
          />
          <AppText variant="small" muted numberOfLines={1} style={styles.label}>
            {item.label}
          </AppText>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: spacing.md },
  cell: { width: '25%', minWidth: 72, alignItems: 'center', gap: spacing.xs },
  label: { textAlign: 'center', maxWidth: 80 },
});
