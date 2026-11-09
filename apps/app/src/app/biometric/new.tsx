import { cmToIn, formatWeight, inToCm, lbToKg, parseNumber } from '@cal/core';
import { Stack } from 'expo-router';
import { useState } from 'react';

import {
  BIOMETRIC_RANGES,
  BIOMETRIC_STORAGE,
  BP_TYPES,
  BiometricTypePicker,
  DateBanner,
  DecimalField,
  FormActions,
  FormError,
  FormScreen,
  TimeField,
  closeScreen,
  combineDateAndTime,
  errorMessage,
  formatShortDate,
  hapticError,
  hapticSuccess,
  mgdlToMmol,
  mmolToMgdl,
  parseTimeOfDay,
  slugifyBiometricType,
  trimNum,
  useDebounced,
  useTargetDate,
  type BiometricKind,
  type GlucoseUnit,
} from '@/components/activity';
import { Segmented, TextField } from '@/components/forms';
import { AppText, Card } from '@/components/ui';
import { useRecentBiometric, type BiometricEntry } from '@/data/activity';
import { useAddBiometrics, type NewBiometric } from '@/data/activity-write';
import { useUnitSystem } from '@/data/profile';
import { todayISO } from '@/state/selected-date';

const VALUE_LABELS: Record<Exclude<BiometricKind, 'blood_pressure'>, string> = {
  weight: 'Weight',
  body_fat: 'Body fat',
  heart_rate: 'Heart rate',
  glucose: 'Blood glucose',
  ketones: 'Ketones',
  waist: 'Waist',
  custom: 'Value',
};

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

export default function NewBiometricScreen() {
  const date = useTargetDate();
  const system = useUnitSystem();
  const imperial = system === 'imperial';

  const [kind, setKind] = useState<BiometricKind>('weight');
  const [valueText, setValueText] = useState('');
  const [systolicText, setSystolicText] = useState('');
  const [diastolicText, setDiastolicText] = useState('');
  const [customName, setCustomName] = useState('');
  const [customUnit, setCustomUnit] = useState('');
  const [glucoseChoice, setGlucoseChoice] = useState<GlucoseUnit | null>(null);
  const [timeText, setTimeText] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const glucoseUnit: GlucoseUnit = glucoseChoice ?? (imperial ? 'mg/dL' : 'mmol/L');
  const add = useAddBiometrics();

  // ---- what is being recorded, in stored units
  const customSlug = slugifyBiometricType(customName);
  const primaryType =
    kind === 'blood_pressure' ? BP_TYPES.systolic : kind === 'custom' ? customSlug : BIOMETRIC_STORAGE[kind].type;
  const debouncedSlug = useDebounced(customSlug, 500);
  const lookupType = kind === 'custom' ? debouncedSlug : primaryType;
  const previous = useRecentBiometric(lookupType, date, lookupType !== '');
  const previousDia = useRecentBiometric(BP_TYPES.diastolic, date, kind === 'blood_pressure');

  const input = parseNumber(valueText);
  const systolic = parseNumber(systolicText);
  const diastolic = parseNumber(diastolicText);
  const time = timeText.trim() === '' ? null : parseTimeOfDay(timeText);

  /** Entered value converted to the stored unit (null when blank/invalid). */
  const storedValue = (() => {
    if (input === null) return null;
    switch (kind) {
      case 'weight':
        return imperial ? lbToKg(input) : input;
      case 'waist':
        return imperial ? inToCm(input) : input;
      case 'glucose':
        return glucoseUnit === 'mg/dL' ? mgdlToMmol(input) : input;
      default:
        return input;
    }
  })();

  const inRange = (key: string, v: number) => {
    const r = BIOMETRIC_RANGES[key];
    return !r || (v >= r.min && v <= r.max);
  };

  const unrealistic = 'That value looks unrealistic. Check the number and unit.';
  const errors = {
    name: kind === 'custom' && customSlug === '' ? 'Enter a name using letters or numbers.' : null,
    value:
      kind === 'blood_pressure'
        ? null
        : storedValue === null
          ? 'Enter a value.'
          : kind === 'custom'
            ? storedValue > 1e9
              ? unrealistic
              : null
            : !inRange(BIOMETRIC_STORAGE[kind].type, storedValue)
              ? unrealistic
              : null,
    systolic:
      kind !== 'blood_pressure'
        ? null
        : systolic === null
          ? 'Enter the top number.'
          : !inRange(BP_TYPES.systolic, systolic)
            ? unrealistic
            : null,
    diastolic:
      kind !== 'blood_pressure'
        ? null
        : diastolic === null
          ? 'Enter the bottom number.'
          : !inRange(BP_TYPES.diastolic, diastolic)
            ? unrealistic
            : systolic !== null && diastolic >= systolic
              ? 'The bottom number must be lower than the top.'
              : null,
    time: timeText.trim() !== '' && time === null ? 'Enter a valid time.' : null,
  };
  const hasErrors = Object.values(errors).some(Boolean);
  const show = <K extends keyof typeof errors>(key: K) => (submitted ? errors[key] : null);

  const switchKind = (next: BiometricKind) => {
    setKind(next);
    setValueText('');
    setSystolicText('');
    setDiastolicText('');
    setSaveError(null);
    setSubmitted(false);
  };

  // ---- units shown in the form
  const unitLabel =
    kind === 'weight'
      ? imperial ? 'lb' : 'kg'
      : kind === 'waist'
        ? imperial ? 'in' : 'cm'
        : kind === 'glucose'
          ? glucoseUnit
          : kind === 'body_fat'
            ? '%'
            : kind === 'heart_rate'
              ? 'bpm'
              : kind === 'ketones'
                ? 'mmol/L'
                : customUnit.trim() || undefined;
  const placeholder =
    kind === 'weight'
      ? imperial ? '155' : '70'
      : kind === 'waist'
        ? imperial ? '33' : '85'
        : kind === 'glucose'
          ? glucoseUnit === 'mg/dL' ? '100' : '5.5'
          : kind === 'body_fat'
            ? '20'
            : kind === 'heart_rate'
              ? '60'
              : kind === 'ketones'
                ? '0.5'
                : undefined;

  const previousText = describePrevious(
    kind,
    previous.data && previous.data.type === primaryType ? previous.data : null,
    previousDia.data ?? null,
    imperial,
    glucoseUnit,
  );
  const previousLoading = previous.isLoading || previousDia.isLoading;

  const onSave = async () => {
    setSubmitted(true);
    setSaveError(null);
    if (hasErrors) return;
    const now = new Date();
    const recordedAt = time
      ? combineDateAndTime(date, time)
      : date === todayISO()
        ? now
        : combineDateAndTime(date, { hours: 12, minutes: 0 });

    let rows: NewBiometric[];
    if (kind === 'blood_pressure') {
      if (systolic === null || diastolic === null) return;
      rows = [
        { entryDate: date, type: BP_TYPES.systolic, value: round(systolic, 1), unit: BP_TYPES.unit, recordedAt },
        { entryDate: date, type: BP_TYPES.diastolic, value: round(diastolic, 1), unit: BP_TYPES.unit, recordedAt },
      ];
    } else if (storedValue !== null && input !== null) {
      const stored = kind === 'custom' ? { type: customSlug, unit: customUnit.trim() || null } : BIOMETRIC_STORAGE[kind];
      // Remember what was typed when it was converted (lb, in, mg/dL) so nothing is lost to rounding.
      const converted = kind === 'weight' ? imperial : kind === 'waist' ? imperial : kind === 'glucose' ? glucoseUnit === 'mg/dL' : false;
      rows = [
        {
          entryDate: date,
          type: stored.type,
          value: round(storedValue, kind === 'custom' ? 4 : 2),
          unit: stored.unit,
          recordedAt,
          meta: converted ? { entered_value: input, entered_unit: unitLabel } : undefined,
        },
      ];
    } else {
      return;
    }

    try {
      await add.mutateAsync(rows);
    } catch (e) {
      hapticError();
      setSaveError(errorMessage(e, 'Could not save the measurement.'));
      return;
    }
    hapticSuccess();
    closeScreen();
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Add biometric' }} />
      <FormScreen>
        <DateBanner date={date} />
        <BiometricTypePicker value={kind} onChange={switchKind} />

        <Card>
          {kind === 'custom' ? (
            <>
              <TextField
                label="Name"
                value={customName}
                onChangeText={setCustomName}
                placeholder="e.g. Resting heart rate, Neck"
                maxLength={60}
                error={show('name')}
              />
              <TextField
                label="Unit (optional)"
                value={customUnit}
                onChangeText={setCustomUnit}
                placeholder="e.g. cm, mmHg, bpm"
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={16}
              />
            </>
          ) : null}

          {kind === 'glucose' ? (
            <Segmented<GlucoseUnit>
              label="Unit"
              options={[
                { value: 'mmol/L', label: 'mmol/L' },
                { value: 'mg/dL', label: 'mg/dL' },
              ]}
              value={glucoseUnit}
              onChange={(u) => {
                setGlucoseChoice(u);
                setValueText('');
              }}
            />
          ) : null}

          {kind === 'blood_pressure' ? (
            <>
              <DecimalField
                label="Systolic (top)"
                unit="mmHg"
                value={systolicText}
                onChange={setSystolicText}
                placeholder="120"
                error={show('systolic')}
              />
              <DecimalField
                label="Diastolic (bottom)"
                unit="mmHg"
                value={diastolicText}
                onChange={setDiastolicText}
                placeholder="80"
                error={show('diastolic')}
              />
            </>
          ) : (
            <DecimalField
              label={VALUE_LABELS[kind]}
              unit={unitLabel}
              value={valueText}
              onChange={setValueText}
              placeholder={placeholder}
              error={show('value')}
            />
          )}

          <AppText variant="small" muted accessibilityLiveRegion="polite">
            {previousLoading
              ? 'Looking up your previous value...'
              : previousText
                ? `Previous: ${previousText}`
                : kind === 'custom' && customSlug === ''
                  ? 'Name it to see your previous value.'
                  : 'No previous value yet.'}
          </AppText>
        </Card>

        <TimeField value={timeText} onChange={setTimeText} />

        <FormError message={saveError} />
        <FormActions saveLabel="Save" onSave={onSave} onCancel={closeScreen} saving={add.isPending} />
      </FormScreen>
    </>
  );
}

/** "80 kg on Nov 3" style summary of the previous reading(s), in the units the form uses. */
function describePrevious(
  kind: BiometricKind,
  row: BiometricEntry | null,
  diastolicRow: BiometricEntry | null,
  imperial: boolean,
  glucoseUnit: GlucoseUnit,
): string | null {
  if (!row) return null;
  const when = formatShortDate(row.entry_date);
  const v = row.value;
  switch (kind) {
    case 'weight':
      return `${formatWeight(row.unit === 'lb' ? lbToKg(v) : v, imperial ? 'imperial' : 'metric')} on ${when}`;
    case 'body_fat':
      return `${trimNum(v, 1)} % on ${when}`;
    case 'blood_pressure':
      return `${trimNum(v, 0)}/${diastolicRow ? trimNum(diastolicRow.value, 0) : '?'} mmHg on ${when}`;
    case 'heart_rate':
      return `${trimNum(v, 0)} bpm on ${when}`;
    case 'glucose':
      return glucoseUnit === 'mg/dL'
        ? `${trimNum(mmolToMgdl(v), 0)} mg/dL on ${when}`
        : `${trimNum(v, 1)} mmol/L on ${when}`;
    case 'ketones':
      return `${trimNum(v, 1)} mmol/L on ${when}`;
    case 'waist':
      return imperial ? `${trimNum(cmToIn(v), 1)} in on ${when}` : `${trimNum(v, 1)} cm on ${when}`;
    case 'custom':
      return `${trimNum(v, 2)}${row.unit ? ` ${row.unit}` : ''} on ${when}`;
  }
}
