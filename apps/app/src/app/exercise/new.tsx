import { exerciseKcalNetMet, kgToLb, lbToKg, parseNumber, type MetActivity } from '@cal/core';
import { Stack } from 'expo-router';
import { useState } from 'react';
import { Pressable } from 'react-native';

import {
  ActivityPicker,
  DateBanner,
  DecimalField,
  FormActions,
  FormError,
  FormScreen,
  QuickAmountChips,
  TimeField,
  closeScreen,
  combineDateAndTime,
  errorMessage,
  formatShortDate,
  hapticError,
  hapticSuccess,
  parseTimeOfDay,
  trimNum,
  useTargetDate,
} from '@/components/activity';
import { Segmented, SwitchRow, TextField } from '@/components/forms';
import { AppText, Card } from '@/components/ui';
import { useRecentBiometric } from '@/data/activity';
import { useAddBiometrics, useAddExercise } from '@/data/activity-write';
import { useUnitSystem } from '@/data/profile';
import { useTheme } from '@/theme';

type Mode = 'activity' | 'custom';

const MINUTE_PRESETS = [15, 30, 45, 60].map((m) => ({ value: m, label: `${m} min` }));
const MAX_MINUTES = 1440;
const MAX_KCAL = 20000;

export default function NewExerciseScreen() {
  const { colors } = useTheme();
  const date = useTargetDate();
  const system = useUnitSystem();
  const weightUnit = system === 'metric' ? 'kg' : 'lb';

  const [mode, setMode] = useState<Mode>('activity');
  const [activity, setActivity] = useState<MetActivity | null>(null);
  const [customName, setCustomName] = useState('');
  const [minutesText, setMinutesText] = useState('');
  /** null = follow the automatic estimate; a string = the user typed their own value. */
  const [kcalOverride, setKcalOverride] = useState<string | null>(null);
  const [weightText, setWeightText] = useState('');
  const [saveWeight, setSaveWeight] = useState(true);
  const [startText, setStartText] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const weightQuery = useRecentBiometric('weight');
  const addExercise = useAddExercise();
  const addBiometrics = useAddBiometrics();
  const saving = addExercise.isPending || addBiometrics.isPending;

  // ---- weight used for the MET estimate: latest logged, else what the user typed here
  const recent = weightQuery.data;
  const recentKg = recent ? (recent.unit === 'lb' ? lbToKg(recent.value) : recent.value) : null;
  const typedWeight = parseNumber(weightText);
  const typedKg = typedWeight !== null && typedWeight > 0 ? (system === 'metric' ? typedWeight : lbToKg(typedWeight)) : null;
  const weightKg = recentKg ?? typedKg;
  const askForWeight = mode === 'activity' && !weightQuery.isLoading && recentKg === null;

  // ---- derived numbers
  const minutes = parseNumber(minutesText);
  const computed =
    mode === 'activity' && activity && weightKg !== null && minutes !== null && minutes > 0
      ? Math.round(exerciseKcalNetMet(activity.met, weightKg, Math.min(minutes, MAX_MINUTES)))
      : null;
  const kcalText = kcalOverride ?? (computed !== null ? String(computed) : '');
  const kcal = parseNumber(kcalText);
  const start = startText.trim() === '' ? null : parseTimeOfDay(startText);

  // ---- validation (errors are shown after the first save attempt)
  const errors = {
    activity: mode === 'activity' && !activity ? 'Choose an activity.' : null,
    name: mode === 'custom' && customName.trim() === '' ? 'Enter a name for the exercise.' : null,
    minutes:
      minutesText.trim() !== '' && (minutes === null || minutes <= 0 || minutes > MAX_MINUTES)
        ? `Enter minutes between 1 and ${MAX_MINUTES}.`
        : mode === 'activity' && minutes === null
          ? 'Enter how many minutes.'
          : null,
    kcal:
      kcal === null
        ? mode === 'activity' && weightKg === null
          ? 'Enter your weight for an estimate, or type the calories burned.'
          : 'Enter the calories burned.'
        : kcal > MAX_KCAL
          ? `Calories must be at most ${MAX_KCAL}.`
          : null,
    start: startText.trim() !== '' && start === null ? 'Enter a valid time.' : null,
  };
  const hasErrors = Object.values(errors).some(Boolean);
  const show = <K extends keyof typeof errors>(key: K) => (submitted ? errors[key] : null);

  const switchMode = (next: Mode) => {
    setMode(next);
    setKcalOverride(null);
    setSaveError(null);
  };

  const onSave = async () => {
    setSubmitted(true);
    setSaveError(null);
    if (hasErrors || kcal === null) return;
    const name = mode === 'activity' ? (activity?.name ?? '') : customName.trim();
    const startedAt = start ? combineDateAndTime(date, start) : null;
    const endedAt = startedAt && minutes ? new Date(startedAt.getTime() + minutes * 60_000) : null;
    try {
      await addExercise.mutateAsync({
        entryDate: date,
        name,
        activityCode: mode === 'activity' ? (activity?.code ?? null) : null,
        minutes: minutes && minutes > 0 ? minutes : null,
        kcal: Math.round(kcal),
        startedAt,
        endedAt,
        countsTowardEnergy: true,
      });
    } catch (e) {
      hapticError();
      setSaveError(errorMessage(e, 'Could not save the exercise.'));
      return;
    }
    // Optionally remember a weight that was typed only to compute the estimate. Never blocks the save.
    if (askForWeight && saveWeight && typedKg !== null) {
      try {
        await addBiometrics.mutateAsync([
          { entryDate: date, type: 'weight', value: Math.round(typedKg * 100) / 100, unit: 'kg' },
        ]);
      } catch {
        // The exercise is already saved; the weight can be logged from "Add biometric".
      }
    }
    hapticSuccess();
    closeScreen();
  };

  const weightNote = recent
    ? `Using your latest weight: ${trimNum(system === 'metric' ? recentKg! : kgToLb(recentKg!), 1)} ${weightUnit} (${formatShortDate(recent.entry_date)}).`
    : null;

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Add exercise' }} />
      <FormScreen>
        <DateBanner date={date} />

        <Segmented<Mode>
          options={[
            { value: 'activity', label: 'Activity' },
            { value: 'custom', label: 'Custom exercise' },
          ]}
          value={mode}
          onChange={switchMode}
        />

        {mode === 'activity' ? (
          <>
            <ActivityPicker value={activity} onChange={setActivity} />
            <FormError message={show('activity')} />
          </>
        ) : (
          <TextField
            label="Exercise name"
            value={customName}
            onChangeText={setCustomName}
            placeholder="e.g. Padel with friends"
            autoCapitalize="sentences"
            maxLength={80}
            error={show('name')}
          />
        )}

        <Card>
          <DecimalField
            label="Duration"
            unit="minutes"
            value={minutesText}
            onChange={setMinutesText}
            placeholder="30"
            hint={mode === 'custom' ? 'Optional for custom exercises.' : undefined}
            error={show('minutes')}
          />
          <QuickAmountChips
            options={MINUTE_PRESETS}
            value={minutes}
            onSelect={(m) => setMinutesText(String(m))}
          />
        </Card>

        <Card>
          <AppText variant="heading">Calories burned</AppText>
          {mode === 'activity' && weightQuery.isLoading ? (
            <AppText variant="small" muted>Looking up your weight...</AppText>
          ) : null}
          {weightNote && mode === 'activity' ? (
            <AppText variant="small" muted>{weightNote}</AppText>
          ) : null}
          {askForWeight ? (
            <>
              <AppText variant="small" muted>
                No weight logged yet. Enter it to estimate calories, or type the calories burned directly.
              </AppText>
              <DecimalField
                label="Your weight"
                unit={weightUnit}
                value={weightText}
                onChange={setWeightText}
                placeholder={system === 'metric' ? '70' : '155'}
              />
              {typedKg !== null ? (
                <SwitchRow
                  label="Also save as my weight"
                  description="Logs this weight for the same date so you only enter it once."
                  value={saveWeight}
                  onChange={setSaveWeight}
                />
              ) : null}
            </>
          ) : null}
          <DecimalField
            label="Calories"
            unit="kcal"
            value={kcalText}
            onChange={setKcalOverride}
            placeholder="0"
            hint={
              computed !== null && activity && weightKg !== null && kcalOverride === null
                ? `Estimate: (${trimNum(activity.met, 1)} MET - 1) x ${trimNum(weightKg, 1)} kg x ${trimNum(minutes ?? 0, 0)} min / 60, the calories above resting. You can edit it.`
                : 'You can always type your own value.'
            }
            error={show('kcal')}
          />
          {kcalOverride !== null && computed !== null ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Reset calories to estimate, ${computed} kilocalories`}
              onPress={() => setKcalOverride(null)}
              hitSlop={8}
              style={{ minHeight: 36, justifyContent: 'center' }}>
              <AppText variant="small" style={{ color: colors.accent, fontWeight: '700' }}>
                Reset to estimate ({computed} kcal)
              </AppText>
            </Pressable>
          ) : null}
        </Card>

        <TimeField label="Start time (optional)" value={startText} onChange={setStartText} />

        <FormError message={saveError} />
        <FormActions saveLabel="Save exercise" onSave={onSave} onCancel={closeScreen} saving={saving} />

        <AppText variant="small" muted>
          Using a connected watch? Workouts imported from your device are used instead, so the same session
          is not counted twice. Log manual exercise for activities your watch does not record.
        </AppText>
      </FormScreen>
    </>
  );
}
