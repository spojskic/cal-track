import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { NutrientCode, NutrientGroup } from '@cal/core';

import { HighlightRings } from '@/components/charts/HighlightRings';
import { NutrientBar } from '@/components/charts/NutrientBar';
import { ProgressRing } from '@/components/charts/ProgressRing';
import { Panel, PanelGrid } from '@/components/panel';
import { AppText } from '@/components/ui';

import type { NutrientModel } from './use-nutrient-model';

/** The nutrition score ring with what it covers. */
function ScoreContent({ model }: { model: NutrientModel }) {
  const { score, scoreColor, coverageText } = model;
  return (
    <View style={styles.scoreRow}>
      <ProgressRing
        value={score ? score.score / 100 : 0}
        size={84}
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
  );
}

/** The rings of the highlighted nutrients, or why there are none. */
function HighlightsContent({ model, size }: { model: NutrientModel; size: number }) {
  const { hasTargets, highlights } = model;
  return highlights.length > 0 ? (
    <HighlightRings items={highlights} size={size} />
  ) : (
    <AppText variant="small" muted>
      {hasTargets ? 'No highlighted nutrient has a target.' : 'Targets are needed for highlighted nutrients.'}
    </AppText>
  );
}

/** "Nutrition score" as a panel of its own (the dashboard). */
export function NutritionScorePanel({ model }: { model: NutrientModel }) {
  return (
    <Panel title="Nutrition score" bodyStyle={styles.centered}>
      <ScoreContent model={model} />
    </Panel>
  );
}

/** "Highlighted nutrients" as a panel of its own (the dashboard). */
export function HighlightedNutrientsPanel({ model }: { model: NutrientModel }) {
  return (
    <Panel title="Highlighted nutrients">
      <HighlightsContent model={model} size={58} />
    </Panel>
  );
}

/** Score and highlighted nutrients together in one compact panel (the diary's side column). */
export function NutrientSummaryPanel({ model }: { model: NutrientModel }) {
  return (
    <Panel title="Nutrient targets" meta="Nutrition score">
      <ScoreContent model={model} />
      <View style={styles.highlights}>
        <AppText variant="small" muted style={styles.subTitle}>
          Highlighted nutrients
        </AppText>
        <HighlightsContent model={model} size={52} />
      </View>
    </Panel>
  );
}

/**
 * The nutrient tables (General, Carbohydrates, Lipids, Protein, Vitamins, Minerals), one panel per group in a grid of equal-height
 * rows. The title strip of a group collapses it, with the same accessible name as on the phone.
 */
export function NutrientGroupPanels({ model, incompleteNutrients }: { model: NutrientModel; incompleteNutrients: readonly NutrientCode[] }) {
  const [collapsed, setCollapsed] = useState<Partial<Record<NutrientGroup, boolean>>>({});
  const { groups } = model;
  if (groups.length === 0) {
    return (
      <Panel title="Nutrient details">
        <AppText muted>Nutrient details appear once you log food.</AppText>
      </Panel>
    );
  }
  return (
    <View style={styles.groups}>
      <PanelGrid>
        {groups.map((group) => {
          const isCollapsed = collapsed[group.code] === true;
          return (
            <Panel
              key={group.code}
              title={group.label}
              meta={`${group.rows.length} nutrients`}
              collapsible={{
                collapsed: isCollapsed,
                onToggle: () => setCollapsed((c) => ({ ...c, [group.code]: !isCollapsed })),
                accessibilityLabel: `${group.label}, ${group.rows.length} nutrients. ${isCollapsed ? 'Expand' : 'Collapse'}`,
              }}
              flush
              bodyStyle={styles.groupBody}>
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
            </Panel>
          );
        })}
      </PanelGrid>
      {incompleteNutrients.length > 0 ? (
        <AppText variant="small" muted>
          * Some logged foods have no data for this nutrient, so the total may be higher.
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  centered: { justifyContent: 'center' },
  scoreRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  coverage: { flex: 1 },
  highlights: { gap: 8 },
  subTitle: { fontWeight: '600' },
  groups: { gap: 12 },
  groupBody: { paddingHorizontal: 14, paddingVertical: 6 },
});
