import { Pressable, StyleSheet, Text } from 'react-native';

import { Glyph, glyphNameFor } from '@/components/Glyph';
import { useTheme } from '@/theme';

/** Round glyph button (a rounded square in the boxy look) used in bars and rows (prev/next, +, overflow). The common glyphs are drawn, so they are centred. */
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
  const { colors, shape } = useTheme();
  const ink = filled ? colors.onPrimary : colors.text;
  const drawn = glyphNameFor(glyph);
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
          borderRadius: shape.circle(size),
          backgroundColor: filled ? colors.primary : pressed ? colors.surfaceAlt : 'transparent',
          opacity: disabled ? 0.4 : pressed && filled ? 0.85 : 1,
        },
      ]}>
      {drawn ? (
        <Glyph name={drawn} size={Math.round(size * 0.55)} color={ink} />
      ) : (
        <Text style={{ fontSize: size * 0.6, lineHeight: size * 0.75, fontWeight: '500', color: ink }}>{glyph}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center' },
});
