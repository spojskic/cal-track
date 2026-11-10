import { useId } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View, type TextInputProps } from 'react-native';

import { radius, spacing, useTheme } from '@/theme';

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
  ...input
}: TextInputProps & { label: string; hint?: string; error?: string | null }) {
  const { colors } = useTheme();
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
        style={[
          styles.input,
          {
            color: colors.text,
            borderColor: error ? colors.danger : colors.border,
            backgroundColor: colors.surfaceAlt,
          },
          input.style,
        ]}
      />
      {error ? (
        <AppText variant="small" style={{ color: colors.danger }}>{error}</AppText>
      ) : hint ? (
        <AppText variant="small" muted>{hint}</AppText>
      ) : null}
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
  ...input
}: Omit<TextInputProps, 'value' | 'onChangeText' | 'onChange'> & {
  label: string;
  /** Raw text being edited. Parse with parseNumber from @cal/core when submitting. */
  value: string;
  onChange: (text: string) => void;
  unit?: string;
  hint?: string;
  error?: string | null;
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
      {...input}
    />
  );
}

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label?: string;
  options: { value: T; label: string }[];
  value: T | null | undefined;
  onChange: (value: T) => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.field}>
      {label ? <AppText variant="label" muted>{label}</AppText> : null}
      <View style={[styles.segmented, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
        {options.map((opt) => {
          const selected = opt.value === value;
          return (
            <Pressable
              key={opt.value}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => onChange(opt.value)}
              style={[styles.segment, selected && { backgroundColor: colors.primary }]}>
              <Text style={[styles.segmentLabel, { color: selected ? colors.onPrimary : colors.text }]}>
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
  value,
  onChange,
}: {
  label: string;
  description?: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.switchRow}>
      <View style={{ flex: 1, gap: 2 }}>
        <AppText variant="body" style={{ fontWeight: '600' }}>{label}</AppText>
        {description ? <AppText variant="small" muted>{description}</AppText> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: colors.primary, false: colors.track }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: spacing.xs },
  input: {
    minHeight: 46,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    fontSize: 16,
  },
  segmented: {
    flexDirection: 'row',
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 3,
    gap: 3,
  },
  segment: { flex: 1, minHeight: 38, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.sm },
  segmentLabel: { fontSize: 14, fontWeight: '600' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
});
