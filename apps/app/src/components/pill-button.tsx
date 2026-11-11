import { Pressable, StyleSheet } from 'react-native';

import { spacing, useTheme } from '@/theme';

import { AppText } from './ui';

/**
 * A small pill button for the actions at the end of a list row (Copy, Revoke, Accept, Decline, Remove). The accessible name is
 * `accessibilityLabel`, which should say what the action is about ("Revoke code K7M2-9QXA-F3TW"): several rows have the same label.
 */
export function PillButton({
  label,
  accessibilityLabel,
  tone = 'neutral',
  disabled,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  tone?: 'neutral' | 'danger' | 'primary';
  disabled?: boolean;
  onPress: () => void;
}) {
  const { colors, radius } = useTheme();
  const filled = tone === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        {
          backgroundColor: filled ? colors.primary : colors.surfaceAlt,
          borderColor: filled ? colors.primary : colors.border,
          borderRadius: radius.pill,
          opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
        },
      ]}>
      <AppText
        variant="small"
        style={[styles.label, { color: filled ? colors.onPrimary : tone === 'danger' ? colors.danger : colors.text }]}>
        {label}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderWidth: 1, minHeight: 32, justifyContent: 'center' },
  label: { fontWeight: '700' },
});
