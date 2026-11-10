import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, type DimensionValue, type LayoutChangeEvent } from 'react-native';

import { Glyph } from '@/components/Glyph';
import { Segmented } from '@/components/forms';
import { AppText } from '@/components/ui';
import {
  DARK_PALETTES,
  LIGHT_PALETTES,
  isDefaultThemePrefs,
  radius,
  spacing,
  useTheme,
  useThemeStore,
  type PaletteDef,
  type ThemeMode,
} from '@/theme';

import { PALETTE_GRID_GAP, paletteCardWidth, paletteColumns } from './palette-grid';

const MODE_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'Match system' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/**
 * One palette as a miniature screen: the frame is the palette's background, the strip on the left its surface, the bars its
 * text colours, the dots its main colour and its warning colour. Only the preview uses the palette's own colours; the
 * border, the check and the name use the colours of the theme that is on screen now.
 */
export function PaletteCard({
  palette,
  selected,
  width,
  onPress,
}: {
  palette: PaletteDef;
  selected: boolean;
  width: DimensionValue;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const p = palette.colors;
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={palette.name}
      accessibilityState={{ selected, checked: selected }}
      // react-native-web ignores accessibilityState; aria-checked is what a browser (and a screen reader) reads on a radio.
      aria-checked={selected}
      onPress={onPress}
      style={({ pressed }) => [styles.card, { width, opacity: pressed ? 0.8 : 1 }]}>
      <View
        style={[
          styles.frame,
          {
            backgroundColor: p.background,
            borderColor: selected ? colors.primary : colors.border,
            borderWidth: selected ? 2 : StyleSheet.hairlineWidth,
          },
        ]}>
        <View style={[styles.strip, { backgroundColor: p.surface }]}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={[styles.stripBar, { backgroundColor: p.textMuted }]} />
          ))}
        </View>
        <View style={styles.body}>
          <View style={[styles.titleBar, { backgroundColor: p.text }]} />
          <View style={[styles.line, { width: '88%', backgroundColor: p.textMuted }]} />
          <View style={[styles.line, { width: '60%', backgroundColor: p.textMuted }]} />
          <View style={styles.dots}>
            <View style={[styles.dot, { backgroundColor: p.primary }]} />
            <View style={[styles.dot, { backgroundColor: p.warning }]} />
          </View>
        </View>
        {selected ? (
          <View style={[styles.check, { backgroundColor: colors.primary }]}>
            <Glyph name="check" size={13} color={colors.onPrimary} strokeWidth={3} />
          </View>
        ) : null}
      </View>
      <Text numberOfLines={1} style={[styles.name, { color: colors.text, fontWeight: selected ? '700' : '500' }]}>
        {palette.name}
      </Text>
    </Pressable>
  );
}

function PaletteGrid({
  title,
  palettes,
  selectedId,
  inUse,
  onSelect,
}: {
  title: string;
  palettes: readonly PaletteDef[];
  selectedId: string;
  /** This side is the one on screen right now. */
  inUse: boolean;
  onSelect: (id: string) => void;
}) {
  const [containerWidth, setContainerWidth] = useState(0);
  const columns = paletteColumns(containerWidth);
  // Until the grid has been measured the cards share the row equally; after that they get exact pixel widths.
  const cardWidth: DimensionValue = containerWidth > 0 ? paletteCardWidth(containerWidth, columns) : '47%';
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <AppText variant="label" muted>{title}</AppText>
        {inUse ? <AppText variant="small" muted>In use now</AppText> : null}
      </View>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={title}
        onLayout={(e: LayoutChangeEvent) => setContainerWidth(Math.floor(e.nativeEvent.layout.width))}
        style={styles.grid}>
        {palettes.map((palette) => (
          <PaletteCard
            key={palette.id}
            palette={palette}
            selected={palette.id === selectedId}
            width={cardWidth}
            onPress={() => onSelect(palette.id)}
          />
        ))}
      </View>
    </View>
  );
}

/** Settings > Display: Mode (Match system / Light / Dark), the light and the dark palette, and a way back to the defaults. */
export function ThemePicker() {
  const { colors, isDark } = useTheme();
  const mode = useThemeStore((s) => s.mode);
  const light = useThemeStore((s) => s.light);
  const dark = useThemeStore((s) => s.dark);
  const setMode = useThemeStore((s) => s.setMode);
  const setLight = useThemeStore((s) => s.setLight);
  const setDark = useThemeStore((s) => s.setDark);
  const reset = useThemeStore((s) => s.reset);
  const isDefault = isDefaultThemePrefs({ mode, light, dark });
  return (
    <View style={styles.root}>
      <Segmented label="Mode" compact options={MODE_OPTIONS} value={mode} onChange={setMode} />
      <AppText variant="small" muted>Match system follows the setting of your device.</AppText>
      <PaletteGrid title="Light palette" palettes={LIGHT_PALETTES} selectedId={light} inUse={!isDark} onSelect={setLight} />
      <PaletteGrid title="Dark palette" palettes={DARK_PALETTES} selectedId={dark} inUse={isDark} onSelect={setDark} />
      {isDefault ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reset to default"
          onPress={reset}
          hitSlop={8}
          style={({ pressed }) => [styles.reset, { opacity: pressed ? 0.7 : 1 }]}>
          <Text style={[styles.resetLabel, { color: colors.text }]}>Reset to default</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.md },
  section: { gap: spacing.sm },
  sectionHeader: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: spacing.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', columnGap: PALETTE_GRID_GAP, rowGap: spacing.md },
  card: { gap: spacing.xs + 2 },
  frame: {
    height: 88,
    flexDirection: 'row',
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  strip: { width: '24%', paddingHorizontal: 6, paddingBottom: 10, gap: 4, justifyContent: 'flex-end' },
  stripBar: { height: 4, borderRadius: 2, width: '76%', opacity: 0.7 },
  body: { flex: 1, paddingHorizontal: 9, paddingVertical: 10, gap: 5, justifyContent: 'center' },
  titleBar: { height: 7, width: '72%', borderRadius: 3 },
  line: { height: 4, borderRadius: 2, opacity: 0.75 },
  dots: { flexDirection: 'row', gap: 5, marginTop: 3 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  check: {
    position: 'absolute',
    top: 6,
    left: 6,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { fontSize: 13, textAlign: 'center' },
  reset: { alignSelf: 'flex-start', paddingVertical: spacing.xs },
  resetLabel: { fontSize: 14, fontWeight: '700', textDecorationLine: 'underline' },
});
