import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import {
  NUTRIENTS,
  NUTRIENT_GROUPS,
  nutritionScore,
  type NutrientCode,
  type NutrientGroup,
  type NutrientMap,
} from '@cal/core';

import { HighlightRings } from '@/components/charts/HighlightRings';
import { NutrientBar } from '@/components/charts/NutrientBar';
import { ProgressRing } from '@/components/charts/ProgressRing';
import { AppText, Card } from '@/components/ui';
import type { ResolvedTargets } from '@/data/targets';
import { spacing, useTheme } from '@/theme';

import { ResponsiveGrid } from './layout';
import { amountOf, buildHighlights, effectiveTarget } from './targets-view';

const SUB_NUTRIENTS = new Set<NutrientCode>([
  'SOLUBLE_FIBER_G',
  'INSOLUBLE_FIBER_G',
  'ADDED_SUGARS_G',
  'SATURATED_FAT_G',
  'MONOUNSATURATED_FAT_G',
  'POLYUNSATURATED_FAT_G',
  'TRANS_FAT_G',
]);

interface NutrientRowData {
  code: NutrientCode;
  name: string;
  unit: string;
  amount: number | undefined;
  min?: number;
  max?: number;
  incomplete: boolean;
  indent: boolean;
}

/**
 * "Nutrient Targets": nutrition score ring, highlighted nutrient rings and the grouped nutrient tables
 * (General, Carbohydrates, Lipids, Protein, Vitamins, Minerals). Rows are listed when they have a target
 * or at least one logged food has data for them.
 */
export function NutrientTargetsPanel({
  totals,
  hasEntries,
  incompleteNutrients,
  targets,
  netCarbs,
}: {
  totals: NutrientMap;
  hasEntries: boolean;
  incompleteNutrients: readonly NutrientCode[];
  targets: ResolvedTargets | undefined;
  netCarbs: boolean;
}) {
  const { colors } = useTheme();
  const [collapsed, setCollapsed] = useState<Partial<Record<NutrientGroup, boolean>>>({});

  const score = useMemo(
    () => (targets && hasEntries ? nutritionScore(totals, targets.nutrients) : undefined),
    [totals, targets, hasEntries],
  );
  const highlights = useMemo(
    () => buildHighlights({ colors, totals, hasEntries, targets, netCarbs }),
    [colors, totals, hasEntries, targets, netCarbs],
  );
  const groups = useMemo(() => {
    const incomplete = new Set(incompleteNutrients);
    return NUTRIENT_GROUPS.map((group) => {
      const rows: NutrientRowData[] = [];
      for (const def of NUTRIENTS) {
        if (def.group !== group.code) continue;
        const target = effectiveTarget(def.code, targets, netCarbs);
        const hasTarget = Boolean(target?.min || target?.max);
        const known = totals[def.code] !== undefined;
        if (!hasTarget && !known) continue;
        rows.push({
          code: def.code,
          name: def.shortName ?? def.name,
          unit: def.unit,
          amount: amountOf(totals, def.code, hasEntries),
          min: target?.min,
          max: target?.max,
          incomplete: incomplete.has(def.code),
          indent: SUB_NUTRIENTS.has(def.code) || (def.group === 'protein' && def.code !== 'PROTEIN_G'),
        });
      }
      return { ...group, rows };
    }).filter((g) => g.rows.length > 0);
  }, [totals, hasEntries, targets, netCarbs, incompleteNutrients]);

  const scoreColor =
    score === undefined ? colors.track : score.score >= 80 ? colors.success : score.score >= 50 ? colors.warning : colors.danger;
  const coverageText = !targets
    ? 'Set up your targets to see a score.'
    : !hasEntries
      ? 'Log food to see your score.'
      : `${Math.round((score?.coverage ?? 0) * 100)}% of targeted nutrients have data in your foods.`;

  return (
    <View style={styles.wrap}>
      <AppText variant="heading">Nutrient Targets</AppText>

      <ResponsiveGrid minItemWidth={260}>
        <Card>
          <AppText variant="label" muted>
            Nutrition score
          </AppText>
          <View style={styles.scoreRow}>
            <ProgressRing
              value={score ? score.score / 100 : 0}
              size={96}
              color={scoreColor}
              label={score ? `${score.score}%` : '-'}
              sublabel="All targets"
              animated
              accessibilityLabel={score ? `Nutrition score ${score.score} percent for all targets` : 'Nutrition score not available'}
            />
            <AppText variant="small" muted style={styles.coverage}>
              {coverageText}
            </AppText>
          </View>
        </Card>
        <Card>
          <AppText variant="label" muted>
            Highlighted nutrients
          </AppText>
          {highlights.length > 0 ? (
            <HighlightRings items={highlights} size={58} />
          ) : (
            <AppText variant="small" muted>
              {targets ? 'No highlighted nutrient has a target.' : 'Targets are needed for highlighted nutrients.'}
            </AppText>
          )}
        </Card>
      </ResponsiveGrid>

      {groups.length === 0 ? (
        <Card>
          <AppText muted>Nutrient details appear once you log food.</AppText>
        </Card>
      ) : (
        <ResponsiveGrid minItemWidth={340}>
          {groups.map((group) => {
            const isCollapsed = collapsed[group.code] === true;
            return (
              <Card key={group.code} style={styles.groupCard}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: !isCollapsed }}
                  accessibilityLabel={`${group.label}, ${group.rows.length} nutrients. ${isCollapsed ? 'Expand' : 'Collapse'}`}
                  onPress={() => setCollapsed((c) => ({ ...c, [group.code]: !isCollapsed }))}
                  style={styles.groupHeader}>
                  <AppText variant="heading" style={styles.groupTitle}>
                    {group.label}
                  </AppText>
                  <AppText muted>{isCollapsed ? '▸' : '▾'}</AppText>
                </Pressable>
                {!isCollapsed ? (
                  <View style={styles.rows}>
                    {group.rows.map((row) => (
                      <NutrientBar
                        key={row.code}
                        name={row.name}
                        amount={row.amount}
                        unit={row.unit}
                        min={row.min}
                        max={row.max}
                        incomplete={row.incomplete}
                        indent={row.indent}
                      />
                    ))}
                  </View>
                ) : null}
              </Card>
            );
          })}
        </ResponsiveGrid>
      )}

      {incompleteNutrients.length > 0 ? (
        <AppText variant="small" muted>
          * Some logged foods have no data for this nutrient, so the total may be higher.
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.md },
  scoreRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  coverage: { flex: 1 },
  groupCard: { gap: spacing.xs },
  groupHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 36 },
  groupTitle: { fontSize: 16 },
  rows: { gap: 0 },
});
