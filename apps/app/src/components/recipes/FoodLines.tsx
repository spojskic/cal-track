// Shared "food + amount" lines used by the recipe editor (ingredients) and the saved meal editor (items).
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { deriveNutrients, parseNumber, scaleNutrients } from '@cal/core';

import { hapticSelection } from '@/components/food/feedback';
import { formatKcal, trimNumber } from '@/components/food/format';
import { buildServingOptions, isGramOption, type ServingOption } from '@/components/food/serving';
import { ServingPicker } from '@/components/food/serving-picker';
import { AppText, Button } from '@/components/ui';
import type { IngredientFood } from '@/data/recipes';
import { clearFoodPick, startFoodPick, type PickHandler, type PickedFood } from '@/state/food-picker';
import { spacing, useTheme } from '@/theme';

/** One editable line: which food, and the amount typed in one of the food's units. */
export interface FoodLine {
  /** Stable local key (not the food id: the same food may appear twice). */
  key: string;
  foodId: string;
  name: string;
  brand: string | null;
  amountText: string;
  /** {@link ServingOption.key} of the chosen unit; 'g' = grams. */
  unitKey: string;
}

let sequence = 0;
const nextKey = () => `line-${(sequence += 1)}`;

export const GRAM_OPTION: ServingOption = { key: 'g', label: 'g', gramsPerUnit: 1, kind: 'mass', defaultAmount: 100 };

export function lineFromGrams(
  foodId: string,
  name: string,
  brand: string | null,
  grams: number,
  decimals = 1,
): FoodLine {
  return { key: nextKey(), foodId, name, brand, amountText: trimNumber(grams, decimals), unitKey: 'g' };
}

export function lineFromPick(food: PickedFood): FoodLine {
  return lineFromGrams(food.id, food.name, food.brand, food.grams);
}

/** Units for a line: the food's portions, g, oz and volume units when the density is known. Always has grams. */
export function lineOptions(food: IngredientFood | undefined, imperial: boolean): ServingOption[] {
  if (!food) return [GRAM_OPTION];
  const options = buildServingOptions(food.portions, food.densityGPerMl, imperial);
  const hasGrams = options.some(isGramOption);
  return hasGrams ? options : [GRAM_OPTION, ...options];
}

/** The option a line points at; falls back to grams (a "100 g" portion replaces the synthetic grams option). */
export function selectedOption(line: FoodLine, options: ServingOption[]): ServingOption {
  return options.find((o) => o.key === line.unitKey) ?? options.find(isGramOption) ?? GRAM_OPTION;
}

/** Grams of a line, or null while the amount is empty / not a positive number. */
export function lineGrams(line: FoodLine, options: ServingOption[]): number | null {
  const amount = parseNumber(line.amountText);
  if (amount === null || amount <= 0) return null;
  return amount * selectedOption(line, options).gramsPerUnit;
}

export const MAX_LINE_GRAMS = 100_000;

export function lineKcal(food: IngredientFood | undefined, grams: number | null): number | undefined {
  if (!food || grams === null) return undefined;
  return deriveNutrients(scaleNutrients(food.nutrients, grams), { carbBasis: food.carbBasis }).ENERGY_KCAL;
}

/** State and operations for a list of {@link FoodLine}. */
export function useFoodLines(initial: () => FoodLine[]) {
  const [lines, setLines] = useState<FoodLine[]>(initial);
  /** The line whose editor is open (a newly added line opens right away). */
  const [openKey, setOpenKey] = useState<string | null>(null);

  return {
    lines,
    openKey,
    setOpenKey,
    add: (line: FoodLine) => {
      setLines((prev) => [...prev, line]);
      setOpenKey(line.key);
    },
    patch: (key: string, patch: Partial<Pick<FoodLine, 'amountText' | 'unitKey'>>) =>
      setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l))),
    remove: (key: string) => {
      setLines((prev) => prev.filter((l) => l.key !== key));
      setOpenKey((cur) => (cur === key ? null : cur));
    },
    move: (key: string, direction: -1 | 1) =>
      setLines((prev) => {
        const index = prev.findIndex((l) => l.key === key);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= prev.length) return prev;
        const next = prev.slice();
        const [item] = next.splice(index, 1);
        if (item) next.splice(target, 0, item);
        return next;
      }),
  };
}

/**
 * Returns a function that opens the search screen in pick mode and passes the chosen food to `onPick`.
 * The pending request is cancelled when the calling screen unmounts.
 */
export function useFoodPickRequest(onPick: (food: PickedFood) => void): () => void {
  const latest = useRef(onPick);
  const active = useRef<PickHandler | null>(null);
  useEffect(() => {
    latest.current = onPick;
  });
  useEffect(
    () => () => {
      if (active.current) clearFoodPick(active.current);
    },
    [],
  );
  return () => {
    const handler: PickHandler = (food) => latest.current(food);
    active.current = handler;
    startFoodPick(handler);
  };
}

export function FoodLineList({
  lines,
  foods,
  loading,
  imperial,
  openKey,
  onOpenChange,
  onChange,
  onRemove,
  onMove,
  emptyText,
}: {
  lines: FoodLine[];
  foods: ReadonlyMap<string, IngredientFood>;
  loading: boolean;
  imperial: boolean;
  /** The line whose editor is open. */
  openKey: string | null;
  onOpenChange: (key: string | null) => void;
  onChange: (key: string, patch: Partial<Pick<FoodLine, 'amountText' | 'unitKey'>>) => void;
  onRemove: (key: string) => void;
  onMove: (key: string, direction: -1 | 1) => void;
  emptyText: string;
}) {
  if (lines.length === 0) {
    return (
      <AppText muted accessibilityLiveRegion="polite">
        {emptyText}
      </AppText>
    );
  }
  return (
    <View style={styles.list}>
      {lines.map((line, index) => (
        <FoodLineRow
          key={line.key}
          line={line}
          food={foods.get(line.foodId)}
          loading={loading}
          imperial={imperial}
          expanded={openKey === line.key}
          canMoveUp={index > 0}
          canMoveDown={index < lines.length - 1}
          onToggle={() => onOpenChange(openKey === line.key ? null : line.key)}
          onChange={(patch) => onChange(line.key, patch)}
          onRemove={() => onRemove(line.key)}
          onMove={(direction) => onMove(line.key, direction)}
        />
      ))}
    </View>
  );
}

function FoodLineRow({
  line,
  food,
  loading,
  imperial,
  expanded,
  canMoveUp,
  canMoveDown,
  onToggle,
  onChange,
  onRemove,
  onMove,
}: {
  line: FoodLine;
  food: IngredientFood | undefined;
  loading: boolean;
  imperial: boolean;
  expanded: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<Pick<FoodLine, 'amountText' | 'unitKey'>>) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  const { colors, radius } = useTheme();
  const options = lineOptions(food, imperial);
  const selected = selectedOption(line, options);
  const grams = lineGrams(line, options);
  const tooBig = grams !== null && grams > MAX_LINE_GRAMS;
  const validGrams = grams !== null && !tooBig ? grams : null;
  const kcal = lineKcal(food, validGrams);
  const missing = !food && !loading;
  const amountError =
    line.amountText.trim() !== '' && grams === null
      ? 'Enter a number greater than 0'
      : tooBig
        ? 'That amount is too large'
        : null;

  const summary =
    validGrams === null
      ? 'Enter an amount'
      : `${trimNumber(parseNumber(line.amountText) ?? 0, 2)} ${selected.label} = ${trimNumber(validGrams, 1)} g${
          kcal === undefined ? '' : ` \u00B7 ${formatKcal(kcal)} kcal`
        }`;

  function changeUnit(option: ServingOption) {
    hapticSelection();
    const current = validGrams ?? option.defaultAmount * option.gramsPerUnit;
    onChange({ unitKey: option.key, amountText: trimNumber(current / option.gramsPerUnit, 2) });
  }

  return (
    <View
      style={[
        styles.row,
        { backgroundColor: colors.surface, borderColor: amountError || missing ? colors.danger : colors.border, borderRadius: radius.md },
      ]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${line.name}. ${summary}. ${expanded ? 'Collapse' : 'Edit amount'}`}
        onPress={onToggle}
        style={({ pressed }) => [styles.head, pressed && { opacity: 0.7 }]}>
        <View style={styles.headText}>
          <AppText style={styles.name} numberOfLines={2}>
            {line.name}
          </AppText>
          {line.brand ? (
            <AppText variant="small" muted numberOfLines={1}>
              {line.brand}
            </AppText>
          ) : null}
          <AppText variant="small" muted={!amountError && !missing} style={amountError || missing ? { color: colors.danger } : undefined}>
            {missing ? 'This food could not be loaded' : summary}
            {food?.archived ? ' \u00B7 older version' : ''}
          </AppText>
        </View>
        <AppText muted>{expanded ? '\u25BE' : '\u25B8'}</AppText>
      </Pressable>
      {expanded ? (
        <View style={[styles.editor, { borderTopColor: colors.border }]}>
          <ServingPicker
            amountText={line.amountText}
            onAmountChange={(text) => onChange({ amountText: text })}
            options={options}
            selectedKey={selected.key}
            onSelect={changeUnit}
            grams={grams}
            kcal={kcal}
            onUseGrams={(gramOption) => onChange({ unitKey: gramOption.key })}
            error={amountError}
          />
          <View style={styles.actions}>
            <View style={styles.actionButton}>
              <Button label="Move up" variant="secondary" disabled={!canMoveUp} onPress={() => onMove(-1)} />
            </View>
            <View style={styles.actionButton}>
              <Button label="Move down" variant="secondary" disabled={!canMoveDown} onPress={() => onMove(1)} />
            </View>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove ${line.name}`}
            onPress={onRemove}
            style={styles.remove}>
            <AppText style={{ color: colors.danger, fontWeight: '700' }}>Remove</AppText>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.sm },
  row: { borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, minHeight: 60 },
  headText: { flex: 1, gap: 2 },
  name: { fontWeight: '600', fontSize: 15 },
  editor: { borderTopWidth: StyleSheet.hairlineWidth, padding: spacing.md, gap: spacing.md },
  actions: { flexDirection: 'row', gap: spacing.sm },
  actionButton: { flex: 1 },
  remove: { alignItems: 'center', justifyContent: 'center', minHeight: 44 },
});
