import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/theme';

import type { WorkoutKind } from './kinds';

interface KindSymbol {
  name: SymbolViewProps['name'];
  /** One letter for platforms without the symbol (the web build). */
  glyph: string;
}

const SYMBOLS: Record<WorkoutKind, KindSymbol> = {
  running: { name: { ios: 'figure.run', android: 'directions_run' }, glyph: 'R' },
  walking: { name: { ios: 'figure.walk', android: 'directions_walk' }, glyph: 'W' },
  hiking: { name: { ios: 'figure.hiking', android: 'hiking' }, glyph: 'H' },
  cycling: { name: { ios: 'figure.outdoor.cycle', android: 'directions_bike' }, glyph: 'C' },
  swimming: { name: { ios: 'figure.pool.swim', android: 'pool' }, glyph: 'S' },
  rowing: { name: { ios: 'figure.rower', android: 'rowing' }, glyph: 'R' },
  strength: { name: { ios: 'dumbbell.fill', android: 'fitness_center' }, glyph: 'T' },
  yoga: { name: { ios: 'figure.yoga', android: 'self_improvement' }, glyph: 'Y' },
  cardio: { name: { ios: 'heart.fill', android: 'favorite' }, glyph: 'C' },
  other: { name: { ios: 'figure.mixed.cardio', android: 'sports' }, glyph: 'E' },
};

/** The icon of a kind of workout, in a round tinted badge. Decorative: the row's own label says what it is. */
export function WorkoutIcon({ kind, size = 40 }: { kind: WorkoutKind; size?: number }) {
  const { colors } = useTheme();
  const symbol = SYMBOLS[kind];
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.badge, { width: size, height: size, borderRadius: size / 2, backgroundColor: colors.surfaceAlt }]}>
      <SymbolView
        name={symbol.name}
        size={size * 0.5}
        tintColor={colors.primary}
        fallback={<Text style={[styles.glyph, { color: colors.primary, fontSize: size * 0.4 }]}>{symbol.glyph}</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { alignItems: 'center', justifyContent: 'center' },
  glyph: { fontWeight: '800' },
});
