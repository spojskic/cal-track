import { StyleSheet, View } from 'react-native';
import { KCAL_PER_G } from '@cal/core';

import { spacing, useTheme } from '@/theme';

import { AppText, Card } from '../ui';
import { formatAmount, formatKcal } from './format';

/** Big calories number plus protein / carbs / fat grams and share of energy. Values may be unknown (undefined). */
export function MacroSummary({
  kcal,
  protein,
  carbs,
  fat,
  estimated = false,
}: {
  kcal: number | undefined;
  protein: number | undefined;
  carbs: number | undefined;
  fat: number | undefined;
  /** True when kcal was estimated from macros because the food has no energy value. */
  estimated?: boolean;
}) {
  const { colors, shape } = useTheme();
  const pKcal = protein === undefined ? undefined : protein * KCAL_PER_G.protein;
  const cKcal = carbs === undefined ? undefined : carbs * KCAL_PER_G.carbs;
  const fKcal = fat === undefined ? undefined : fat * KCAL_PER_G.fat;
  const allKnown = pKcal !== undefined && cKcal !== undefined && fKcal !== undefined;
  const totalKcal = allKnown ? pKcal + cKcal + fKcal : 0;
  const share = (v: number | undefined) =>
    allKnown && totalKcal > 0 && v !== undefined ? `${Math.round((v / totalKcal) * 100)}%` : '-';

  const macros = [
    { key: 'protein', label: 'Protein', grams: protein, kcal: pKcal, color: colors.protein },
    { key: 'carbs', label: 'Carbs', grams: carbs, kcal: cKcal, color: colors.carbs },
    { key: 'fat', label: 'Fat', grams: fat, kcal: fKcal, color: colors.fat },
  ];

  return (
    <Card>
      <View
        accessible
        accessibilityLabel={`Calories ${kcal === undefined ? 'unknown' : `${formatKcal(kcal)}${estimated ? ', estimated from macros' : ''}`}`}
        style={styles.kcalRow}>
        <AppText style={[styles.kcal, { color: colors.energy }]}>
          {kcal === undefined ? '-' : `${estimated ? '~' : ''}${formatKcal(kcal)}`}
        </AppText>
        <AppText variant="heading" muted>kcal</AppText>
      </View>
      {allKnown && totalKcal > 0 ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.split, { backgroundColor: colors.track, borderRadius: shape.bar(SPLIT_HEIGHT) }]}>
          {macros.map((m) => (
            <View key={m.key} style={{ flex: Math.max(m.kcal ?? 0, 0.0001), backgroundColor: m.color }} />
          ))}
        </View>
      ) : null}
      <View style={styles.macros}>
        {macros.map((m) => (
          <View
            key={m.key}
            accessible
            accessibilityLabel={`${m.label} ${m.grams === undefined ? 'unknown' : `${formatAmount(m.grams, 'g')} grams`}, ${share(m.kcal)} of energy`}
            style={styles.macro}>
            <View style={styles.macroHead}>
              <View style={[styles.swatch, { backgroundColor: m.color }]} />
              <AppText variant="small" muted>{m.label}</AppText>
            </View>
            <AppText variant="heading">{m.grams === undefined ? '-' : `${formatAmount(m.grams, 'g')} g`}</AppText>
            <AppText variant="small" muted>{share(m.kcal)}</AppText>
          </View>
        ))}
      </View>
    </Card>
  );
}

const SPLIT_HEIGHT = 8;

const styles = StyleSheet.create({
  kcalRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  kcal: { fontSize: 44, fontWeight: '800', lineHeight: 50 },
  split: { flexDirection: 'row', height: SPLIT_HEIGHT, overflow: 'hidden', gap: 2 },
  macros: { flexDirection: 'row', gap: spacing.md },
  macro: { flex: 1, gap: 2 },
  macroHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swatch: { width: 10, height: 10, borderRadius: 5 },
});
