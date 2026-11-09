import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/ui';
import { radius, spacing, useTheme } from '@/theme';

export interface ListOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
  /** Shown instead of the description's colour when the option is disabled. */
  disabledReason?: string;
}

/** Vertical radio list: one selectable card per option with an explanation. */
export function OptionList<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label?: string;
  options: readonly ListOption<T>[];
  value: T | null | undefined;
  onChange: (value: T) => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.list} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {label ? <AppText variant="label" muted>{label}</AppText> : null}
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            accessibilityRole="radio"
            accessibilityLabel={opt.label}
            accessibilityHint={opt.description}
            accessibilityState={{ selected, disabled: Boolean(opt.disabled) }}
            disabled={opt.disabled}
            onPress={() => onChange(opt.value)}
            style={({ pressed }) => [
              styles.option,
              {
                backgroundColor: selected ? colors.surfaceAlt : colors.surface,
                borderColor: selected ? colors.primary : colors.border,
                opacity: opt.disabled ? 0.55 : pressed ? 0.85 : 1,
              },
            ]}>
            <View style={[styles.radio, { borderColor: selected ? colors.primary : colors.textMuted }]}>
              {selected ? <View style={[styles.radioDot, { backgroundColor: colors.primary }]} /> : null}
            </View>
            <View style={styles.text}>
              <AppText variant="body" style={styles.bold}>{opt.label}</AppText>
              {opt.description ? <AppText variant="small" muted>{opt.description}</AppText> : null}
              {opt.disabled && opt.disabledReason ? (
                <AppText variant="small" style={{ color: colors.warning }}>{opt.disabledReason}</AppText>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.sm },
  option: {
    flexDirection: 'row',
    gap: spacing.md,
    alignItems: 'flex-start',
    borderWidth: 1.5,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  text: { flex: 1, gap: 2 },
  bold: { fontWeight: '700' },
});
