import { parseBirthdateInput, type UnitSystem } from '@ration/core';
import { Platform, StyleSheet, View } from 'react-native';
import { useMemo, useState } from 'react';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { unstable_createElement } from 'react-native-web';

import { NumberField, Segmented } from '@/components/forms';
import { PillButton } from '@/components/pill-button';
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

/** The year the birthdate picker starts from: the oldest birthdate it can be scrolled to. */
const BIRTHDATE_MIN_ISO = '1900-01-01';
/** Where the picker sits while the field has no value yet (nothing is stored until a date is picked). */
const BIRTHDATE_DEFAULT_ISO = '1990-01-01';

const dateFromISO = (iso: string): Date => {
  const [y = 1990, m = 1, d = 1] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const isoFromDate = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/**
 * Birthdate picked from a date picker instead of typed: a wheel behind a compact field on iOS, the system
 * calendar dialog on Android, and an HTML date input on the web. The year starts at 1900. The core parser
 * (parseBirthdateInput) still validates the picked date, so the age limits and the error wording stay the
 * ones of the targets resolver. `onChange` receives the picked date as YYYY-MM-DD.
 */
export function BirthdateField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (iso: string) => void;
  error?: string | null;
}) {
  const parsed = parseBirthdateInput(value, todayISO());
  const { colors } = useTheme();
  return (
    <View style={styles.field}>
      <AppText variant="label" muted>Birthdate</AppText>
      <BirthdatePicker iso={parsed.ok ? parsed.iso : null} onPick={onChange} error={error ?? null} />
      {error ? (
        <AppText variant="small" style={{ color: colors.danger }}>{error}</AppText>
      ) : parsed.ok ? (
        <AppText variant="small" muted>{`Age ${parsed.age}.`}</AppText>
      ) : null}
    </View>
  );
}

/** The picker itself, per platform. Kept out of {@link BirthdateField} so its hooks never unmount early. */
function BirthdatePicker({
  iso,
  onPick,
  error,
}: {
  iso: string | null;
  onPick: (iso: string) => void;
  error: string | null;
}) {
  const { colors, radius } = useTheme();
  // An unparseable or missing value leaves the field empty: nothing is picked until the user acts.
  const pickDate = useMemo(() => dateFromISO(iso ?? BIRTHDATE_DEFAULT_ISO), [iso]);
  const borderColor = error ? colors.danger : colors.border;

  if (Platform.OS === 'web') {
    // The one DOM element the app renders directly: <input type="date"> with its own picker UI. React Native
    // draws the field (border, background, padding) around a bare input, because the element itself does not
    // get RNW's border-box reset and its padding would push it out of its container.
    return (
      <View style={[styles.pickerRow, { borderColor, backgroundColor: colors.surfaceAlt, borderRadius: radius.md }]}>
        {unstable_createElement('input', {
          type: 'date',
          min: BIRTHDATE_MIN_ISO,
          max: todayISO(),
          value: iso ?? BIRTHDATE_DEFAULT_ISO,
          'aria-label': 'Birthdate',
          onChange: (event: { target?: { value?: string } }) => {
            const next = event.target?.value;
            if (next) onPick(next);
          },
          style: {
            width: '100%',
            maxWidth: '100%',
            boxSizing: 'border-box',
            borderWidth: 0,
            margin: 0,
            padding: 0,
            backgroundColor: 'transparent',
            color: colors.text,
            fontFamily: 'inherit',
            fontSize: 15,
          },
        })}
      </View>
    );
  }

  if (Platform.OS === 'ios') {
    // Compact: a field-like control that opens the wheel when tapped.
    return (
      <DateTimePicker
        value={pickDate}
        mode="date"
        display="compact"
        minimumDate={dateFromISO(BIRTHDATE_MIN_ISO)}
        maximumDate={new Date()}
        accentColor={colors.primary}
        onChange={(event: DateTimePickerEvent, date?: Date) => {
          if (event.type === 'set' && date) onPick(isoFromDate(date));
        }}
        style={styles.picker}
      />
    );
  }

  return <AndroidBirthdatePicker iso={iso} onPick={onPick} error={error} />;
}

/** Android: the picker is the system dialog and it opens on mount, so mount it on demand only. */
function AndroidBirthdatePicker({
  iso,
  onPick,
  error,
}: {
  iso: string | null;
  onPick: (iso: string) => void;
  error: string | null;
}) {
  const { colors, radius } = useTheme();
  const [shown, setShown] = useState(false);
  const pickDate = useMemo(() => dateFromISO(iso ?? BIRTHDATE_DEFAULT_ISO), [iso]);
  return (
    <View>
      <View style={[styles.pickerRow, { borderColor: error ? colors.danger : colors.border, backgroundColor: colors.surfaceAlt, borderRadius: radius.md }]}>
        <AppText style={[styles.pickerValue, { color: iso ? colors.text : colors.textMuted }]}>
          {iso ?? 'Not chosen yet'}
        </AppText>
        <PillButton
          label="Choose date"
          accessibilityLabel="Choose birthdate"
          onPress={() => setShown(true)}
        />
      </View>
      {shown ? (
        <DateTimePicker
          value={pickDate}
          mode="date"
          display="default"
          minimumDate={dateFromISO(BIRTHDATE_MIN_ISO)}
          maximumDate={new Date()}
          onChange={(event: DateTimePickerEvent, date?: Date) => {
            setShown(false);
            if (event.type === 'set' && date) onPick(isoFromDate(date));
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing.xs },
  row: { flexDirection: 'row', gap: spacing.md },
  flex: { flex: 1 },
  field: { gap: spacing.xs },
  picker: { width: '100%' },
  pickerRow: { borderWidth: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 10, paddingHorizontal: 12, overflow: 'hidden' },
  pickerValue: { flex: 1 },
});
