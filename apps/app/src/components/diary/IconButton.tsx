import { Pressable, StyleSheet, Text } from 'react-native';

import { useTheme } from '@/theme';

/** Round glyph button used in bars and rows (prev/next, +, overflow). */
export function IconButton({
  glyph,
  label,
  onPress,
  size = 40,
  filled = false,
  disabled = false,
}: {
  glyph: string;
  label: string;
  onPress: () => void;
  size?: number;
  /** Primary-colored background (e.g. the + button). */
  filled?: boolean;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: filled ? colors.primary : pressed ? colors.surfaceAlt : 'transparent',
          opacity: disabled ? 0.4 : pressed && filled ? 0.85 : 1,
        },
      ]}>
      <Text style={{ fontSize: size * 0.6, lineHeight: size * 0.75, fontWeight: '500', color: filled ? colors.onPrimary : colors.text }}>
        {glyph}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center' },
});
