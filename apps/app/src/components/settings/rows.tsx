import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AppText } from '@/components/ui';
import { radius, spacing, useTheme } from '@/theme';

/** Tappable list row with a chevron (menu entries). */
export function NavRow({
  label,
  description,
  onPress,
  disabled,
  badge,
}: {
  label: string;
  description?: string;
  onPress: () => void;
  disabled?: boolean;
  badge?: string;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={description ? `${label}. ${description}` : label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.navRow, { opacity: disabled ? 0.5 : pressed ? 0.7 : 1 }]}>
      <View style={styles.flex}>
        <AppText variant="body" style={styles.bold}>{label}</AppText>
        {description ? <AppText variant="small" muted>{description}</AppText> : null}
      </View>
      {badge ? <Badge label={badge} /> : null}
      <Text style={[styles.chevron, { color: colors.textMuted }]}>{'\u203A'}</Text>
    </Pressable>
  );
}

/** Thin divider between rows inside a Card. */
export function Divider() {
  const { colors } = useTheme();
  return <View style={[styles.divider, { backgroundColor: colors.border }]} />;
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
  const { colors } = useTheme();
  const bg = tone === 'primary' ? colors.primary : tone === 'accent' ? colors.accent : colors.surfaceAlt;
  const fg = tone === 'neutral' ? colors.textMuted : colors.onPrimary;
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
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
  const { colors } = useTheme();
  const bar =
    tone === 'warning'
      ? colors.warning
      : tone === 'danger'
        ? colors.danger
        : tone === 'success'
          ? colors.success
          : colors.accent;
  return (
    <View style={[styles.note, { backgroundColor: colors.surfaceAlt, borderLeftColor: bar }]}>
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
  const { colors } = useTheme();
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
  chevron: { fontSize: 22, fontWeight: '300' },
  divider: { height: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
  kvRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingVertical: spacing.xs },
  badge: { borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  badgeLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.4 },
  note: { borderLeftWidth: 4, borderRadius: radius.sm, padding: spacing.md, gap: spacing.xs },
  chip: {
    minHeight: 38,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipLabel: { fontSize: 14, fontWeight: '600' },
  collapsible: { flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: spacing.md },
});
