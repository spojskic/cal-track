import { StyleSheet, Text, View } from 'react-native';

import type { FoodSource } from '@/data/foods';
import { palette, radius, spacing, useTheme } from '@/theme';

interface SourceInfo {
  label: string;
  /** Accessible, spelled-out source name. */
  full: string;
}

const SOURCES: Record<FoodSource, SourceInfo> = {
  fdc_foundation: { label: 'USDA', full: 'USDA FoodData Central' },
  fdc_sr_legacy: { label: 'USDA', full: 'USDA FoodData Central' },
  fdc_fndds: { label: 'USDA', full: 'USDA FoodData Central' },
  fdc_branded: { label: 'USDA', full: 'USDA FoodData Central (branded)' },
  cnf: { label: 'CNF', full: 'Canadian Nutrient File' },
  cofid: { label: 'CoFID', full: 'UK Composition of Foods' },
  off: { label: 'OFF', full: 'Open Food Facts' },
  custom: { label: 'Custom', full: 'Custom food' },
  recipe: { label: 'Recipe', full: 'Recipe' },
  ai_estimate: { label: 'AI', full: 'AI estimate' },
};

export function sourceInfo(source: FoodSource): SourceInfo {
  return SOURCES[source];
}

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
        ? palette.purple
        : source === 'off'
          ? palette.orange
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

const styles = StyleSheet.create({
  badge: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    alignSelf: 'flex-start',
  },
  text: { fontSize: 11, fontWeight: '800', letterSpacing: 0.4 },
});
