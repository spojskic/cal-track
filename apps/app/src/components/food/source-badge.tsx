import { StyleSheet, Text, View } from 'react-native';

import type { FoodSource } from '@/data/foods';
import { radius, spacing, useTheme } from '@/theme';

import { SOURCES, sourceInfo, sourceToneColor, type SourceLabelInfo } from './source-label';

export { sourceInfo };

/** Attribution / licensing line shown on the food detail page, or null when none is needed. */
export function sourceAttribution(source: FoodSource): string | null {
  switch (source) {
    case 'off':
      return 'Data from Open Food Facts, available under the Open Database License (ODbL).';
    case 'fdc_foundation':
    case 'fdc_sr_legacy':
    case 'fdc_fndds':
    case 'fdc_branded':
      return 'Source: USDA FoodData Central.';
    case 'cnf':
      return 'Source: Canadian Nutrient File, Health Canada.';
    case 'cofid':
      return 'Source: UK Composition of Foods Integrated Dataset (CoFID).';
    case 'ai_estimate':
      return 'Estimated by AI. Values are approximate, check them against the package if you can.';
    default:
      return null;
  }
}

/** Small pill that names where a food came from (USDA / CNF / OFF / Custom / AI ...). */
export function SourceBadge({ source }: { source: FoodSource }) {
  const { colors } = useTheme();
  const info = SOURCES[source];
  const tint =
    source === 'custom' || source === 'recipe'
      ? colors.accent
      : source === 'ai_estimate'
        ? colors.fat
        : source === 'off'
          ? colors.energy
          : colors.textMuted;
  return (
    <View
      accessible
      accessibilityLabel={`Source: ${info.full}`}
      style={[styles.badge, { backgroundColor: `${tint}22`, borderColor: `${tint}66` }]}>
      <Text style={[styles.text, { color: tint }]}>{info.label}</Text>
    </View>
  );
}

/**
 * The right-aligned source label of a flat list row: plain coloured text ("Custom Food" in the primary colour,
 * "Custom Recipe" / "Saved Meal" in teal, database names muted). Build `info` with `foodSourceLabel` or `SAVED_MEAL_LABEL`.
 */
export function SourceLabel({ info }: { info: SourceLabelInfo }) {
  const { colors } = useTheme();
  return (
    <Text
      accessibilityLabel={`Source: ${info.full}`}
      numberOfLines={1}
      style={[styles.label, { color: sourceToneColor(info.tone, colors) }]}>
      {info.text}
    </Text>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 12, fontWeight: '700', textAlign: 'right', flexShrink: 0, maxWidth: 110 },
  badge: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    alignSelf: 'flex-start',
  },
  text: { fontSize: 11, fontWeight: '800', letterSpacing: 0.4 },
});
