import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

export function Chip({
  label,
  sublabel,
  selected,
  onPress,
  disabled,
  tile,
  accessibilityLabel,
}: {
  label: string;
  sublabel?: string;
  selected?: boolean;
  onPress: () => void;
  disabled?: boolean;
  /** Large tap tile (used for one-tap water amounts). */
  tile?: boolean;
  accessibilityLabel?: string;
}) {
  const { colors, radius } = useTheme();
  const bg = selected ? colors.primary : colors.surfaceAlt;
  const fg = selected ? colors.onPrimary : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (sublabel ? `${label}, ${sublabel}` : label)}
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        tile ? styles.tile : styles.chip,
        {
          backgroundColor: bg,
          borderColor: selected ? colors.primary : colors.border,
          borderRadius: tile ? radius.lg : radius.pill,
          opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
        },
      ]}>
      <AppText
        variant={tile ? 'heading' : 'body'}
        style={{ color: fg, fontWeight: '700', fontSize: tile ? 18 : 14 }}>
        {label}
      </AppText>
      {sublabel ? (
        <AppText variant="small" style={{ color: selected ? colors.onPrimary : colors.textMuted }}>
          {sublabel}
        </AppText>
      ) : null}
    </Pressable>
  );
}

export interface ChipOption<T extends string | number> {
  value: T;
  label: string;
  sublabel?: string;
}

/**
 * Wrapping row of preset buttons (15/30/45/60 min, 250 mL, ...). With `value` it behaves as a
 * single-select; without it each press just reports the value (one-tap actions).
 */
export function QuickAmountChips<T extends string | number>({
  label,
  options,
  value,
  onSelect,
  disabled,
  tile,
}: {
  label?: string;
  options: ChipOption<T>[];
  value?: T | null;
  onSelect: (value: T) => void;
  disabled?: boolean;
  tile?: boolean;
}) {
  return (
    <View style={styles.group}>
      {label ? <AppText variant="label" muted>{label}</AppText> : null}
      <View style={styles.row}>
        {options.map((o) => (
          <View key={String(o.value)} style={tile ? styles.tileCell : undefined}>
            <Chip
              label={o.label}
              sublabel={o.sublabel}
              selected={value !== undefined && value !== null && o.value === value}
              disabled={disabled}
              tile={tile}
              onPress={() => onSelect(o.value)}
            />
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing.xs },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileCell: { flexBasis: '47%', flexGrow: 1 },
  tile: {
    minHeight: 76,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
});
