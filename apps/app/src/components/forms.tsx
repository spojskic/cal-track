import { useId } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View, type TextInputProps } from 'react-native';

import { spacing, useTheme } from '@/theme';

import { AppText } from './ui';

/**
 * Labelled text input. The visible label is also the input's accessible name (`accessibilityLabel` / `aria-label`),
 * and is linked to it with `nativeID` + `accessibilityLabelledBy`, so screen readers (and browser tests that look
 * a field up by its label) find the field. An explicit `accessibilityLabel` / `aria-label` from the caller wins.
 */
export function TextField({
  label,
  hint,
  error,
  warning,
  ...input
}: TextInputProps & {
  label: string;
  hint?: string;
  error?: string | null;
  /** "Check this value" marker (orange border and a "?" hint), e.g. a number the AI was unsure about. An error wins. */
  warning?: string | null;
}) {
  const { colors, radius } = useTheme();
  const labelId = `field-label-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  const explicitName = input.accessibilityLabel ?? input['aria-label'];
  return (
    <View style={styles.field}>
      <AppText variant="label" muted nativeID={labelId}>{label}</AppText>
      <TextInput
        placeholderTextColor={colors.textMuted}
        {...input}
        accessibilityLabel={explicitName ?? label}
        aria-label={explicitName ?? label}
        {...(explicitName === undefined ? { accessibilityLabelledBy: labelId } : {})}
        {...(warning && !error ? { accessibilityHint: warning } : {})}
        style={[
          styles.input,
          {
            color: colors.text,
            borderColor: error ? colors.danger : warning ? colors.warning : colors.border,
            backgroundColor: colors.surfaceAlt,
            borderRadius: radius.md,
          },
          warning && !error ? styles.inputWarning : null,
          input.style,
        ]}
      />
      {error ? (
        <AppText variant="small" style={{ color: colors.danger }}>{error}</AppText>
      ) : warning ? (
        <WarningHint>{warning}</WarningHint>
      ) : hint ? (
        <AppText variant="small" muted>{hint}</AppText>
      ) : null}
    </View>
  );
}

/** A "?" badge and a short sentence: the value above it needs a second look. Not an error (nothing is blocked). */
export function WarningHint({ children }: { children: string }) {
  const { colors, radius } = useTheme();
  return (
    <View style={styles.warningRow}>
      <View accessible={false} style={[styles.warningBadge, { backgroundColor: colors.warning, borderRadius: radius.pill }]}>
        <Text style={[styles.warningBadgeText, { color: colors.onWarning }]}>?</Text>
      </View>
      <AppText variant="small" style={styles.warningText}>{children}</AppText>
    </View>
  );
}

/** Text input that edits a number as text (so users can type "1." or "") and reports parsed value. */
export function NumberField({
  label,
  value,
  onChange,
  unit,
  hint,
  error,
  warning,
  ...input
}: Omit<TextInputProps, 'value' | 'onChangeText' | 'onChange'> & {
  label: string;
  /** Raw text being edited. Parse with parseNumber from @ration/core when submitting. */
  value: string;
  onChange: (text: string) => void;
  unit?: string;
  hint?: string;
  error?: string | null;
  /** "Check this value" marker, see TextField. */
  warning?: string | null;
}) {
  return (
    <TextField
      label={unit ? `${label} (${unit})` : label}
      value={value}
      onChangeText={onChange}
      keyboardType="decimal-pad"
      inputMode="decimal"
      hint={hint}
      error={error}
      warning={warning}
      {...input}
    />
  );
}

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  compact,
}: {
  label?: string;
  options: { value: T; label: string }[];
  value: T | null | undefined;
  onChange: (value: T) => void;
  /** Lower, tighter segments (list screens that keep the control above a long list). Default: the regular size. */
  compact?: boolean;
}) {
  const { colors, radius, shape } = useTheme();
  const segmentRadius = shape.inner(radius.pill, compact ? SEGMENTED_COMPACT_PADDING : SEGMENTED_PADDING);
  return (
    <View style={styles.field}>
      {label ? <AppText variant="label" muted>{label}</AppText> : null}
      <View
        style={[
          styles.segmented,
          compact && styles.segmentedCompact,
          { backgroundColor: colors.surfaceAlt, borderColor: colors.border, borderRadius: radius.pill },
        ]}>
        {options.map((opt) => {
          const selected = opt.value === value;
          return (
            <Pressable
              key={opt.value}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => onChange(opt.value)}
              style={[
                styles.segment,
                compact && styles.segmentCompact,
                { borderRadius: segmentRadius },
                selected && { backgroundColor: colors.primary },
              ]}>
              <Text style={[styles.segmentLabel, compact && styles.segmentLabelCompact, { color: selected ? colors.onPrimary : colors.text }]}>
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function SwitchRow({
  label,
  description,
  warning,
  value,
  onChange,
}: {
  label: string;
  description?: string;
  /** "Check this" hint under the description, see WarningHint. */
  warning?: string | null;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.switchRow}>
      <View style={{ flex: 1, gap: 2 }}>
        <AppText variant="body" style={{ fontWeight: '600' }}>{label}</AppText>
        {description ? <AppText variant="small" muted>{description}</AppText> : null}
        {warning ? <WarningHint>{warning}</WarningHint> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: colors.primary, false: colors.track }}
      />
    </View>
  );
}

const SEGMENTED_PADDING = 3;
const SEGMENTED_COMPACT_PADDING = 2;

const styles = StyleSheet.create({
  field: { gap: spacing.xs },
  input: {
    minHeight: 46,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    fontSize: 16,
  },
  inputWarning: { borderWidth: 2 },
  warningRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  warningBadge: { width: 18, height: 18, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  warningBadgeText: { fontSize: 12, fontWeight: '800', lineHeight: 15 },
  warningText: { flex: 1 },
  segmented: {
    flexDirection: 'row',
    borderWidth: StyleSheet.hairlineWidth,
    padding: SEGMENTED_PADDING,
    gap: SEGMENTED_PADDING,
  },
  segmentedCompact: { padding: SEGMENTED_COMPACT_PADDING, gap: SEGMENTED_COMPACT_PADDING },
  segment: { flex: 1, minHeight: 38, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.sm },
  segmentCompact: { minHeight: 32, paddingHorizontal: spacing.xs },
  segmentLabel: { fontSize: 14, fontWeight: '600' },
  segmentLabelCompact: { fontSize: 13 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
});
