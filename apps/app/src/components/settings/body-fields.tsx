import { parseBirthdateInput, type UnitSystem } from '@ration/core';
import { StyleSheet, View } from 'react-native';

import { NumberField, Segmented, TextField } from '@/components/forms';
import { AppText } from '@/components/ui';
import { todayISO } from '@/state/selected-date';
import { spacing, useTheme } from '@/theme';

import type { HeightInput } from './inputs';

const UNIT_OPTIONS: { value: UnitSystem; label: string }[] = [
  { value: 'metric', label: 'Metric (kg, cm)' },
  { value: 'imperial', label: 'Imperial (lb, ft)' },
];

export function UnitToggle({
  value,
  onChange,
  label = 'Units',
}: {
  value: UnitSystem;
  onChange: (value: UnitSystem) => void;
  label?: string;
}) {
  return <Segmented label={label} options={UNIT_OPTIONS} value={value} onChange={onChange} />;
}

/** Height in cm (metric) or ft + in (imperial). Error text shows under the fields. */
export function HeightFields({
  value,
  onChange,
  system,
  error,
}: {
  value: HeightInput;
  onChange: (next: HeightInput) => void;
  system: UnitSystem;
  error?: string | null;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.group}>
      {system === 'metric' ? (
        <NumberField
          label="Height"
          unit="cm"
          value={value.cm}
          onChange={(cm) => onChange({ ...value, cm })}
          error={error}
        />
      ) : (
        <>
          <View style={styles.row}>
            <View style={styles.flex}>
              <NumberField
                label="Height"
                unit="ft"
                value={value.ft}
                onChange={(ft) => onChange({ ...value, ft })}
                keyboardType="number-pad"
                inputMode="numeric"
              />
            </View>
            <View style={styles.flex}>
              <NumberField
                label="Inches"
                unit="in"
                value={value.inch}
                onChange={(inch) => onChange({ ...value, inch })}
              />
            </View>
          </View>
          {error ? <AppText variant="small" style={{ color: colors.danger }}>{error}</AppText> : null}
        </>
      )}
    </View>
  );
}

/** Birthdate typed as YYYY-MM-DD or DD.MM.YYYY, validated with the core parser. */
export function BirthdateField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (text: string) => void;
  error?: string | null;
}) {
  const parsed = parseBirthdateInput(value, todayISO());
  return (
    <TextField
      label="Birthdate"
      value={value}
      onChangeText={onChange}
      placeholder="YYYY-MM-DD"
      autoCapitalize="none"
      autoCorrect={false}
      keyboardType="numbers-and-punctuation"
      hint={parsed.ok ? `Age ${parsed.age}. Also accepts DD.MM.YYYY.` : 'Type YYYY-MM-DD or DD.MM.YYYY.'}
      error={error}
    />
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing.xs },
  row: { flexDirection: 'row', gap: spacing.md },
  flex: { flex: 1 },
});
