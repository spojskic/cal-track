import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { type NutrientCode, type NutrientGroup, type NutrientMap } from '@ration/core';

import { HighlightRings } from '@/components/charts/HighlightRings';
import { NutrientBar } from '@/components/charts/NutrientBar';
import { ProgressRing } from '@/components/charts/ProgressRing';
import { AppText, Card } from '@/components/ui';
import type { ResolvedTargets } from '@/data/targets';
import { spacing } from '@/theme';

import { ResponsiveGrid } from './layout';
import { useNutrientModel } from './use-nutrient-model';

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
  const [collapsed, setCollapsed] = useState<Partial<Record<NutrientGroup, boolean>>>({});
  const { score, scoreColor, coverageText, highlights, groups } = useNutrientModel({
    totals,
    hasEntries,
    incompleteNutrients,
    targets,
    netCarbs,
  });

  return (
    <View style={styles.wrap}>
      <AppText variant="heading">Nutrient Targets</AppText>

      {/* ONE grid for every card: separate grids each end with a gap under their shorter card (masonry columns only close gaps within a grid). */}
      <ResponsiveGrid minItemWidth={300}>
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
        {groups.length === 0 ? (
          <Card>
            <AppText muted>Nutrient details appear once you log food.</AppText>
          </Card>
        ) : (
          groups.map((group) => {
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
          })
        )}
      </ResponsiveGrid>

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
