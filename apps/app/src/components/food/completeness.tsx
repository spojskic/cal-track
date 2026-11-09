import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';

import { AppText } from '../ui';

export type CompletenessLevel = 'high' | 'medium' | 'low' | 'unknown';

/**
 * Buckets a 0..1 completeness. A typical packaged-food label covers ~15% of the catalog, a
 * lab-analysed generic food ~60% or more.
 */
export function completenessLevel(value: number | null | undefined): CompletenessLevel {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unknown';
  if (value >= 0.35) return 'high';
  if (value >= 0.12) return 'medium';
  return 'low';
}

const LABEL: Record<CompletenessLevel, string> = {
  high: 'Detailed nutrient data',
  medium: 'Label-level nutrient data',
  low: 'Limited nutrient data',
  unknown: 'Nutrient data completeness unknown',
};

export function useCompletenessColor(level: CompletenessLevel): string {
  const { colors } = useTheme();
  switch (level) {
    case 'high':
      return colors.success;
    case 'medium':
      return colors.warning;
    case 'low':
      return colors.danger;
    default:
      return colors.border;
  }
}

/** Coloured dot: green = detailed, amber = label-level, red = limited. */
export function CompletenessDot({ value, size = 10 }: { value: number | null | undefined; size?: number }) {
  const level = completenessLevel(value);
  const color = useCompletenessColor(level);
  const pct = value === null || value === undefined ? null : Math.round(value * 100);
  return (
    <View
      accessible
      accessibilityLabel={pct === null ? LABEL[level] : `${LABEL[level]}, ${pct} percent of nutrients`}
      style={[styles.dot, { width: size, height: size, borderRadius: size / 2, backgroundColor: color }]}
    />
  );
}

/** Dot + text, e.g. for the food detail header. */
export function CompletenessLabel({ value }: { value: number | null | undefined }) {
  const level = completenessLevel(value);
  return (
    <View style={styles.label}>
      <CompletenessDot value={value} />
      <AppText variant="small" muted>
        {LABEL[level]}
        {value !== null && value !== undefined ? ` (${Math.round(value * 100)}%)` : ''}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  dot: {},
  label: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
