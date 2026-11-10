import { Pressable, StyleSheet, Text, View } from 'react-native';
import { parseNumber } from '@cal/core';

import { spacing, useTheme } from '@/theme';

import { NumberField } from '../forms';
import { AppText } from '../ui';
import { trimNumber } from './format';
import { amountWarning, isGramOption, type AmountWarning, type ServingOption } from './serving';

/**
 * Non-blocking warning for an implausible amount, with an optional one-tap "Use N g" switch.
 * Shared by the serving picker and the diary entry editor.
 */
export function AmountWarningNote({
  warning,
  onUseGrams,
}: {
  warning: AmountWarning;
  onUseGrams?: () => void;
}) {
  const { colors, radius } = useTheme();
  return (
    <View
      accessibilityRole="alert"
      style={[styles.warning, { backgroundColor: colors.surfaceAlt, borderLeftColor: colors.warning, borderRadius: radius.sm }]}>
      <AppText variant="small">{warning.message}</AppText>
      {warning.gramsAlternative !== null && onUseGrams ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Use ${trimNumber(warning.gramsAlternative, 2)} g`}
          onPress={onUseGrams}
          style={({ pressed }) => [
            styles.warningButton,
            { borderColor: colors.border, backgroundColor: colors.surface, borderRadius: radius.pill, opacity: pressed ? 0.7 : 1 },
          ]}>
          <AppText variant="small" style={{ fontWeight: '700', color: colors.accent }}>
            {`Use ${trimNumber(warning.gramsAlternative, 2)} g`}
          </AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * Amount field + unit chips with a live "= N g" conversion. State comes from `useServing`.
 * Warns (without blocking) when the amount is implausible, e.g. 200 x a 174 g portion = 34.8 kg; `onUseGrams`
 * then offers a one-tap switch that keeps the typed number and reads it as grams.
 */
export function ServingPicker({
  amountText,
  onAmountChange,
  options,
  selectedKey,
  onSelect,
  grams,
  kcal,
  onUseGrams,
  error,
}: {
  amountText: string;
  onAmountChange: (text: string) => void;
  options: ServingOption[];
  selectedKey: string | undefined;
  onSelect: (option: ServingOption) => void;
  grams: number | null;
  /** Energy of the whole amount, when known (adds the 5000 kcal plausibility check). */
  kcal?: number | undefined;
  /** Keeps the typed number and switches the unit to grams. */
  onUseGrams?: (gramOption: ServingOption) => void;
  error?: string | null;
}) {
  const { colors, radius } = useTheme();
  const gramOption = options.find(isGramOption);
  const warning = amountWarning({
    grams,
    kcal,
    amount: parseNumber(amountText),
    inGrams: gramOption === undefined || gramOption.key === selectedKey,
  });
  return (
    <View style={styles.wrap}>
      <NumberField
        label="Amount"
        value={amountText}
        onChange={onAmountChange}
        error={error}
        accessibilityLabel="Amount"
        selectTextOnFocus
      />
      <View style={styles.units}>
        <AppText variant="label" muted>Unit</AppText>
        <View style={styles.chips} accessibilityRole="radiogroup">
          {options.map((o) => {
            const selected = o.key === selectedKey;
            return (
              <Pressable
                key={o.key}
                accessibilityRole="radio"
                accessibilityLabel={`${o.label}, ${trimNumber(o.gramsPerUnit, 1)} grams each`}
                accessibilityState={{ selected }}
                onPress={() => onSelect(o)}
                style={[
                  styles.chip,
                  {
                    backgroundColor: selected ? colors.primary : colors.surfaceAlt,
                    borderColor: selected ? colors.primary : colors.border,
                    borderRadius: radius.pill,
                  },
                ]}>
                <Text
                  numberOfLines={1}
                  style={[styles.chipText, { color: selected ? colors.onPrimary : colors.text }]}>
                  {o.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      <AppText variant="body" accessibilityLiveRegion="polite" style={{ fontWeight: '700' }}>
        {grams === null ? '= - g' : `= ${trimNumber(grams, 1)} g`}
      </AppText>
      {warning ? (
        <AmountWarningNote
          warning={warning}
          {...(gramOption && onUseGrams ? { onUseGrams: () => onUseGrams(gramOption) } : {})}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.md },
  units: { gap: spacing.xs },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    minHeight: 36,
    maxWidth: '100%',
    paddingHorizontal: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: { fontSize: 14, fontWeight: '600' },
  warning: { borderLeftWidth: 4, padding: spacing.md, gap: spacing.sm },
  warningButton: {
    alignSelf: 'flex-start',
    minHeight: 36,
    paddingHorizontal: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
