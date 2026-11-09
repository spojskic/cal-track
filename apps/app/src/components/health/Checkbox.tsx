import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AppText } from '@/components/ui';
import { radius, spacing, useTheme } from '@/theme';

/** Labelled checkbox row (no native dependency). */
export function CheckboxRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityHint={description}
      accessibilityState={{ checked, disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={() => onChange(!checked)}
      style={({ pressed }) => [styles.row, { opacity: disabled ? 0.5 : pressed ? 0.75 : 1 }]}>
      <View
        style={[
          styles.box,
          { borderColor: checked ? colors.primary : colors.textMuted, backgroundColor: checked ? colors.primary : 'transparent' },
        ]}>
        {checked ? <Text style={[styles.tick, { color: colors.onPrimary }]}>{'\u2713'}</Text> : null}
      </View>
      <View style={styles.text}>
        <AppText variant="body" style={styles.label}>{label}</AppText>
        {description ? <AppText variant="small" muted>{description}</AppText> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, minHeight: 44, paddingVertical: spacing.xs },
  box: {
    width: 24,
    height: 24,
    borderRadius: radius.sm / 2,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  tick: { fontSize: 15, fontWeight: '800', lineHeight: 18 },
  text: { flex: 1, gap: 2 },
  label: { fontWeight: '600' },
});
