import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AppText } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

/** Width reserved for a row icon, so labels line up whether or not a row has one. */
const ICON_SLOT = 24;
/** Horizontal padding of a `list` row (it sits inside a Card that has `LIST_CARD_PADDING`). */
const LIST_ROW_PADDING = spacing.md;
/** Padding of a Card that holds `list` rows: small, so the hover highlight of a row stays inside the rounded card. */
export const LIST_CARD_PADDING = spacing.sm;
/** Divider inset that lines a divider up with the label of a `list` row with an icon. */
export const LIST_DIVIDER_INSET = LIST_ROW_PADDING + ICON_SLOT + spacing.md;

/**
 * Tappable list row with a chevron (menu entries).
 * - `icon`: a small symbol at the left (decorative: hidden from screen readers, the label says it).
 * - `variant="list"`: a row for a grouped list (the More screen): its own horizontal padding, a rounded highlight on hover and press
 *   (put it in a Card with `padding: LIST_CARD_PADDING` and `gap: 0`), and a description cut at two lines. Default: unchanged.
 */
export function NavRow({
  label,
  description,
  onPress,
  disabled,
  badge,
  icon,
  variant = 'default',
}: {
  label: string;
  description?: string;
  onPress: () => void;
  disabled?: boolean;
  badge?: string;
  icon?: SymbolViewProps['name'];
  variant?: 'default' | 'list';
}) {
  const { colors, radius } = useTheme();
  const [hovered, setHovered] = useState(false);
  const list = variant === 'list';
  const accessibleName = [label, description, badge].filter(Boolean).join('. ');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibleName}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => [
        styles.navRow,
        list && styles.listRow,
        list ? { borderRadius: radius.sm } : null,
        list && !disabled && (hovered || pressed) ? { backgroundColor: colors.surfaceAlt } : null,
        { opacity: disabled ? 0.5 : pressed ? 0.7 : 1 },
      ]}>
      {icon ? (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.iconSlot}>
          <SymbolView name={icon} size={20} tintColor={colors.textMuted} />
        </View>
      ) : null}
      <View style={styles.flex}>
        <AppText variant="body" style={styles.bold}>{label}</AppText>
        {description ? (
          <AppText variant="small" muted numberOfLines={list ? 2 : undefined}>{description}</AppText>
        ) : null}
      </View>
      {badge ? <Badge label={badge} /> : null}
      <Text style={[styles.chevron, { color: colors.textMuted }]}>{'\u203A'}</Text>
    </Pressable>
  );
}

/** Thin divider between rows inside a Card. `inset`: leave that much space at the left (see `LIST_DIVIDER_INSET`). */
export function Divider({ inset }: { inset?: number }) {
  const { colors } = useTheme();
  return <View style={[styles.divider, { backgroundColor: colors.border }, inset ? { marginLeft: inset } : null]} />;
}

/** Label on the left, value on the right; `strong` for subtotal / total rows. */
export function KeyValueRow({
  label,
  hint,
  value,
  strong,
  valueColor,
}: {
  label: string;
  hint?: string;
  value: string;
  strong?: boolean;
  valueColor?: string;
}) {
  return (
    <View style={styles.kvRow} accessible accessibilityLabel={`${label}: ${value}`}>
      <View style={styles.flex}>
        <AppText variant="body" style={strong ? styles.bold : undefined}>{label}</AppText>
        {hint ? <AppText variant="small" muted>{hint}</AppText> : null}
      </View>
      <AppText variant="body" style={[strong ? styles.bold : undefined, valueColor ? { color: valueColor } : null]}>
        {value}
      </AppText>
    </View>
  );
}

/** Small pill, used for nutrient target kinds and "Optional" markers. */
export function Badge({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'primary' | 'accent' }) {
  const { colors, radius } = useTheme();
  const bg = tone === 'primary' ? colors.primary : tone === 'accent' ? colors.accent : colors.surfaceAlt;
  const fg = tone === 'neutral' ? colors.textMuted : colors.onPrimary;
  return (
    <View style={[styles.badge, { backgroundColor: bg, borderRadius: radius.pill }]}>
      <Text style={[styles.badgeLabel, { color: fg }]}>{label}</Text>
    </View>
  );
}

/** Inline callout. `tone` picks the accent bar colour. */
export function Note({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  children: ReactNode;
}) {
  const { colors, radius } = useTheme();
  const bar =
    tone === 'warning'
      ? colors.warning
      : tone === 'danger'
        ? colors.danger
        : tone === 'success'
          ? colors.success
          : colors.accent;
  return (
    <View style={[styles.note, { backgroundColor: colors.surfaceAlt, borderLeftColor: bar, borderRadius: radius.sm }]}>
      {typeof children === 'string' ? <AppText variant="small">{children}</AppText> : children}
    </View>
  );
}

/** Selectable pill (rate presets, macro style presets). */
export function Chip({
  label,
  selected,
  onPress,
  accessibilityLabel,
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
}) {
  const { colors, radius } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected: Boolean(selected) }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: selected ? colors.primary : colors.surfaceAlt,
          borderColor: selected ? colors.primary : colors.border,
          borderRadius: radius.pill,
          opacity: pressed ? 0.8 : 1,
        },
      ]}>
      <Text style={[styles.chipLabel, { color: selected ? colors.onPrimary : colors.text }]}>{label}</Text>
    </Pressable>
  );
}

/** Collapsible section header (e.g. "Target breakdown"). */
export function CollapsibleHeader({
  label,
  open,
  onToggle,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded: open }}
      onPress={onToggle}
      style={({ pressed }) => [styles.collapsible, { opacity: pressed ? 0.7 : 1 }]}>
      <AppText variant="body" style={[styles.bold, styles.flex]}>{label}</AppText>
      <AppText variant="small" style={{ color: colors.accent, fontWeight: '700' }}>{open ? 'Hide' : 'Show'}</AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, gap: 2 },
  bold: { fontWeight: '700' },
  navRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 52, paddingVertical: spacing.sm },
  listRow: { minHeight: 56, paddingHorizontal: LIST_ROW_PADDING },
  iconSlot: { width: ICON_SLOT, alignItems: 'center', justifyContent: 'center' },
  chevron: { fontSize: 22, fontWeight: '300' },
  divider: { height: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
  kvRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingVertical: spacing.xs },
  badge: { paddingHorizontal: spacing.sm, paddingVertical: 2 },
  badgeLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.4 },
  note: { borderLeftWidth: 4, padding: spacing.md, gap: spacing.xs },
  chip: {
    minHeight: 38,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipLabel: { fontSize: 14, fontWeight: '600' },
  collapsible: { flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: spacing.md },
});
