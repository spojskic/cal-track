import { Pressable, StyleSheet, Text, View } from 'react-native';

import { radius, spacing, useTheme } from '@/theme';

import { NumberField } from '../forms';
import { AppText } from '../ui';
import { trimNumber } from './format';
import type { ServingOption } from './serving';

/** Amount field + unit chips with a live "= N g" conversion. State comes from `useServing`. */
export function ServingPicker({
  amountText,
  onAmountChange,
  options,
  selectedKey,
  onSelect,
  grams,
  error,
}: {
  amountText: string;
  onAmountChange: (text: string) => void;
  options: ServingOption[];
  selectedKey: string | undefined;
  onSelect: (option: ServingOption) => void;
  grams: number | null;
  error?: string | null;
}) {
  const { colors } = useTheme();
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
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: { fontSize: 14, fontWeight: '600' },
});
