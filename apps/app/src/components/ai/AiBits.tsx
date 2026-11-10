import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AppText } from '@/components/ui';
import { radius, spacing, useTheme } from '@/theme';

import { confidenceLevel } from './review-model';

/** Pill in the fat (purple) colour that marks numbers guessed by the AI. Shown wherever an AI-estimated food appears. */
export function AiEstimateBadge({ compact }: { compact?: boolean }) {
  const { colors } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel="AI estimate. Not verified nutrition data."
      style={[styles.pill, { backgroundColor: `${colors.fat}22`, borderColor: `${colors.fat}88` }]}>
      <Text style={[styles.pillText, { color: colors.fat }]}>{compact ? 'AI' : 'AI estimate'}</Text>
    </View>
  );
}

/** High / medium / low confidence of the AI's identification. */
export function ConfidenceChip({ value }: { value: number }) {
  const { colors } = useTheme();
  const level = confidenceLevel(value);
  const tint = level === 'high' ? colors.success : level === 'medium' ? colors.warning : colors.danger;
  const label = level === 'high' ? 'High' : level === 'medium' ? 'Medium' : 'Low';
  return (
    <View
      accessible
      accessibilityLabel={`${label} confidence`}
      style={[styles.pill, { backgroundColor: `${tint}22`, borderColor: `${tint}88` }]}>
      <Text style={[styles.pillText, { color: tint }]}>{label} confidence</Text>
    </View>
  );
}

export function Pill({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'primary' | 'success' }) {
  const { colors } = useTheme();
  const tint = tone === 'primary' ? colors.primary : tone === 'success' ? colors.success : colors.textMuted;
  return (
    <View style={[styles.pill, { backgroundColor: `${tint}22`, borderColor: `${tint}66` }]}>
      <Text style={[styles.pillText, { color: tint }]}>{label}</Text>
    </View>
  );
}

/** Strings / numbers (also several of them, e.g. `{msg} more text`) must be wrapped in <Text>. */
function isPlainText(children: ReactNode): boolean {
  const plain = (c: unknown) => typeof c === 'string' || typeof c === 'number';
  return plain(children) || (Array.isArray(children) && children.every(plain));
}

/** Inline callout with a coloured bar. */
export function Notice({
  tone = 'info',
  children,
  live,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  children: ReactNode;
  /** Announce changes to screen readers (errors, results). */
  live?: boolean;
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
    <View
      accessibilityRole={live ? 'alert' : undefined}
      accessibilityLiveRegion={live ? 'polite' : undefined}
      style={[styles.notice, { backgroundColor: colors.surfaceAlt, borderLeftColor: bar }]}>
      {isPlainText(children) ? <AppText variant="small">{children}</AppText> : children}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    alignSelf: 'flex-start',
  },
  pillText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.3 },
  notice: { borderLeftWidth: 4, borderRadius: radius.sm, padding: spacing.md, gap: spacing.xs },
});
