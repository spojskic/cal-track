import type { NutrientMap } from '@cal/core';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Glyph } from '@/components/Glyph';
import { formatAmount, formatKcal } from '@/components/food/format';
import { SourceBadge } from '@/components/food/source-badge';
import { AppText, Button } from '@/components/ui';
import type { FoodSummary } from '@/data/foods';
import { spacing, useTheme } from '@/theme';

import { AiEstimateBadge, ConfidenceChip, Notice, Pill } from './AiBits';
import { FoodPicker } from './FoodPicker';
import {
  formatGrams,
  isAiEstimateItem,
  itemGrams,
  itemNutrients,
  itemProblem,
  type ReviewItem,
} from './review-model';

/** "245 kcal | P 12 g | C 20 g | F 8 g"; unknown parts show "-". */
export function nutrientLine(n: NutrientMap | null): string {
  if (!n) return '- kcal  |  P -  |  C -  |  F -';
  const g = (v: number | undefined) => (v === undefined ? '-' : `${formatAmount(v, 'g')} g`);
  return `${formatKcal(n.ENERGY_KCAL)} kcal  |  P ${g(n.PROTEIN_G)}  |  C ${g(n.CARBS_G)}  |  F ${g(n.FAT_G)}`;
}

function stepFor(grams: number): number {
  return grams >= 200 ? 25 : grams >= 50 ? 10 : 5;
}

export function ReviewItemCard({
  item,
  error,
  onChange,
  onRemove,
}: {
  item: ReviewItem;
  /** Add-to-diary error for this item, if any. */
  error?: string | null;
  onChange: (patch: Partial<ReviewItem>) => void;
  onRemove: () => void;
}) {
  const { colors, radius } = useTheme();
  const [picking, setPicking] = useState(false);
  const locked = item.added === true;
  const grams = itemGrams(item);
  const problem = locked ? null : itemProblem(item);
  const nutrients = itemNutrients(item);
  const aiEstimate = isAiEstimateItem(item);

  function pickFood(food: FoodSummary) {
    onChange({
      choice: { kind: 'food', food },
      alternatives: item.alternatives.filter((a) => a.id !== food.id),
    });
    setPicking(false);
  }

  function nudge(direction: 1 | -1) {
    const base = grams > 0 ? grams : 100;
    const next = Math.max(1, base + direction * stepFor(base));
    onChange({ gramsText: formatGrams(next) });
  }

  const range =
    item.gramsLow !== undefined && item.gramsHigh !== undefined
      ? `The AI thinks ${formatGrams(item.gramsLow)} - ${formatGrams(item.gramsHigh)} g is plausible.`
      : null;

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: colors.surface,
          borderColor: problem || error ? colors.danger : colors.border,
          borderRadius: radius.lg,
        },
        locked && { opacity: 0.7 },
      ]}>
      <View style={styles.titleRow}>
        <View style={styles.flex}>
          <AppText variant="body" style={styles.name}>{item.name}</AppText>
          {item.originalText || item.preparation ? (
            <AppText variant="small" muted>
              {[item.originalText ? `\u201C${item.originalText}\u201D` : null, item.preparation].filter(Boolean).join('  \u00B7  ')}
            </AppText>
          ) : null}
        </View>
        {!locked ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove ${item.name}`}
            onPress={onRemove}
            hitSlop={10}
            style={styles.remove}>
            <Glyph name="close" size={18} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>

      <View style={styles.pills}>
        {item.confidence !== null ? <ConfidenceChip value={item.confidence} /> : <Pill label="Added by you" />}
        {aiEstimate ? <AiEstimateBadge /> : null}
        {locked ? <Pill label="Added to diary" tone="success" /> : null}
      </View>

      {item.choice.kind === 'food' ? (
        <View style={styles.match}>
          <AppText variant="label" muted>Matched food</AppText>
          <View style={styles.matchRow}>
            <AppText variant="body" style={[styles.flex, styles.bold]} numberOfLines={2}>
              {item.choice.food.name}
              {item.choice.food.brand ? `  \u00B7  ${item.choice.food.brand}` : ''}
            </AppText>
            <SourceBadge source={item.choice.food.source} />
          </View>
          {item.choice.food.source === 'ai_estimate' ? (
            <AppText variant="small" muted>An earlier AI estimate of yours. Values are approximate.</AppText>
          ) : null}
        </View>
      ) : item.choice.kind === 'estimate' ? (
        <Notice tone="warning">
          {`No match in the food database, so the AI estimated the nutrition (${Math.round((item.estimate?.confidence ?? 0) * 100)}% confidence). It is saved as an AI estimate food and is not verified.`}
        </Notice>
      ) : (
        <Notice tone="danger">{problem ?? 'No match in the food database.'}</Notice>
      )}

      {!locked ? (
        <View style={styles.actions}>
          <Button
            label={item.choice.kind === 'food' ? 'Change food' : 'Choose a food'}
            variant="secondary"
            onPress={() => setPicking((v) => !v)}
          />
          {item.estimate && item.choice.kind === 'food' ? (
            <Button label="Use AI estimate" variant="ghost" onPress={() => onChange({ choice: { kind: 'estimate' } })} />
          ) : null}
        </View>
      ) : null}

      {picking && !locked ? (
        <FoodPicker
          title={`Food for \u201C${item.name}\u201D`}
          suggestions={item.alternatives}
          initialQuery=""
          onPick={pickFood}
          onClose={() => setPicking(false)}
        />
      ) : null}

      <View style={styles.amountRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Decrease amount of ${item.name}`}
          disabled={locked}
          onPress={() => nudge(-1)}
          style={[styles.step, { backgroundColor: colors.surfaceAlt, borderColor: colors.border, borderRadius: radius.md }]}>
          <Glyph name="minus" size={22} color={colors.text} />
        </Pressable>
        <View style={styles.flex}>
          <AppText variant="label" muted>Amount (g)</AppText>
          <TextInput
            value={item.gramsText}
            onChangeText={(gramsText) => onChange({ gramsText })}
            editable={!locked}
            keyboardType="decimal-pad"
            inputMode="decimal"
            selectTextOnFocus
            accessibilityLabel={`Amount in grams for ${item.name}`}
            placeholder="grams"
            placeholderTextColor={colors.textMuted}
            style={[
              styles.input,
              {
                color: colors.text,
                borderColor: grams > 0 ? colors.border : colors.danger,
                backgroundColor: colors.surfaceAlt,
                borderRadius: radius.md,
              },
            ]}
          />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Increase amount of ${item.name}`}
          disabled={locked}
          onPress={() => nudge(1)}
          style={[styles.step, { backgroundColor: colors.surfaceAlt, borderColor: colors.border, borderRadius: radius.md }]}>
          <Glyph name="plus" size={22} color={colors.text} />
        </Pressable>
      </View>
      {range ? <AppText variant="small" muted>{range}</AppText> : null}
      {item.confidence !== null && item.confidence < 0.5 && !locked ? (
        <AppText variant="small" style={{ color: colors.warning }}>
          Low confidence: double-check the food and the amount.
        </AppText>
      ) : null}

      <AppText
        variant="small"
        muted
        accessibilityLabel={`This item: ${nutrientLine(nutrients).replace(/\|/g, ',')}`}>
        {nutrientLine(nutrients)}
      </AppText>
      {error ? <AppText variant="small" style={{ color: colors.danger }}>{error}</AppText> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, padding: spacing.md, gap: spacing.sm },
  flex: { flex: 1, gap: 2 },
  bold: { fontWeight: '700' },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  name: { fontWeight: '700', fontSize: 17 },
  remove: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  match: { gap: 2 },
  matchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  amountRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  step: {
    width: 44,
    height: 46,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    minHeight: 46,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
  },
});
