import { formatWeight, parseBirthdateInput, type Sex, type UnitSystem } from '@ration/core';
import { Stack, router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { NumberField, Segmented, SwitchRow, TextField } from '@/components/forms';
import { BirthdateField, HeightFields, UnitToggle } from '@/components/settings/body-fields';
import { formatShortDate } from '@/components/settings/format';
import {
  convertHeightInput,
  heightToInput,
  parseBodyFatInput,
  parseHeightInput,
  parseWeightInput,
  weightUnitLabel,
  type HeightInput,
} from '@/components/settings/inputs';
import { Divider, KeyValueRow, Note } from '@/components/settings/rows';
import { SaveRow, errorMessage } from '@/components/settings/save-row';
import { AppText, Button, Card, Screen } from '@/components/ui';
import { useProfile, useUpdateProfile, type Profile } from '@/data/profile';
import { useLatestBody, useLogWeight, useWeightHistory } from '@/data/weight';
import { todayISO } from '@/state/selected-date';
import { spacing, useTheme } from '@/theme';

interface ProfileDraft {
  displayName: string;
  sex: Sex | null;
  birthdate: string;
  height: HeightInput;
  unitSystem: UnitSystem;
  pregnant: boolean;
  lactating: boolean;
}

function draftFromProfile(p: Profile): ProfileDraft {
  return {
    displayName: p.display_name ?? '',
    sex: p.sex,
    birthdate: p.birthdate ?? '',
    height: heightToInput(p.height_cm === null ? null : Number(p.height_cm), p.unit_system),
    unitSystem: p.unit_system,
    pregnant: p.pregnant,
    lactating: p.lactating,
  };
}

function LogWeightCard({ profile }: { profile: Profile }) {
  const { colors } = useTheme();
  const unitSystem = profile.unit_system;
  const body = useLatestBody();
  const history = useWeightHistory(90);
  const log = useLogWeight();
  const [weight, setWeight] = useState('');
  const [bodyFat, setBodyFat] = useState('');
  const [attempted, setAttempted] = useState(false);

  const parsedWeight = parseWeightInput(weight, unitSystem);
  const parsedFat = parseBodyFatInput(bodyFat);
  const latest = body.data;
  const recent = [...(history.data ?? [])].reverse().slice(0, 5);

  const submit = () => {
    setAttempted(true);
    if (parsedWeight.value === null || parsedFat.error) return;
    log.mutate(
      { weightKg: parsedWeight.value, bodyFatPct: parsedFat.value },
      {
        onSuccess: () => {
          setWeight('');
          setBodyFat('');
          setAttempted(false);
        },
      },
    );
  };

  return (
    <Card>
      <AppText variant="heading">Log weight</AppText>
      {latest?.weightKg ? (
        <AppText variant="small" muted>
          {`Latest: ${formatWeight(latest.weightKg, unitSystem)}${latest.weightDate ? ` on ${formatShortDate(latest.weightDate)}` : ''}${latest.bodyFatPct !== null ? `, ${latest.bodyFatPct}% body fat` : ''}`}
        </AppText>
      ) : null}
      <NumberField
        label="Weight"
        unit={weightUnitLabel(unitSystem)}
        value={weight}
        onChange={setWeight}
        error={attempted ? parsedWeight.error : null}
      />
      <NumberField
        label="Body fat (optional)"
        unit="%"
        value={bodyFat}
        onChange={setBodyFat}
        error={attempted ? parsedFat.error : null}
      />
      <Button label={`Log weight for ${formatShortDate(todayISO())}`} onPress={submit} loading={log.isPending} />
      {log.isSuccess && weight === '' ? (
        <AppText variant="small" style={{ color: colors.success }} accessibilityLiveRegion="polite">
          Logged. Your targets were updated.
        </AppText>
      ) : null}
      {log.error ? <Note tone="danger">{errorMessage(log.error)}</Note> : null}
      {recent.length > 0 ? (
        <>
          <Divider />
          <AppText variant="label" muted>Recent weigh-ins</AppText>
          {recent.map((p) => (
            <KeyValueRow key={p.date} label={formatShortDate(p.date)} value={formatWeight(p.kg, unitSystem)} />
          ))}
        </>
      ) : null}
    </Card>
  );
}

function ProfileEditor({ profile }: { profile: Profile }) {
  const saved = draftFromProfile(profile);
  const [edit, setEdit] = useState<ProfileDraft | null>(null);
  const update = useUpdateProfile();
  const draft = edit ?? saved;

  const birth = parseBirthdateInput(draft.birthdate, todayISO());
  const height = parseHeightInput(draft.height, draft.unitSystem);
  const dirty = edit !== null && JSON.stringify(edit) !== JSON.stringify(saved);
  const errors = {
    sex: draft.sex === null ? 'Choose male or female.' : null,
    birthdate: birth.ok ? null : birth.error,
    height: height.error,
  };
  const valid = !errors.sex && !errors.birthdate && !errors.height;
  const set = (patch: Partial<ProfileDraft>) => setEdit({ ...draft, ...patch });

  const onSave = () => {
    if (!valid || !birth.ok || height.value === null || draft.sex === null) return;
    update.mutate(
      {
        display_name: draft.displayName.trim() || null,
        sex: draft.sex,
        birthdate: birth.iso,
        height_cm: Math.round(height.value * 10) / 10,
        unit_system: draft.unitSystem,
        pregnant: draft.sex === 'female' && draft.pregnant,
        lactating: draft.sex === 'female' && draft.lactating,
      },
      { onSuccess: () => setEdit(null) },
    );
  };

  return (
    <>
      <Card>
        <AppText variant="heading">Personal details</AppText>
        <TextField
          label="Display name"
          value={draft.displayName}
          onChangeText={(displayName) => set({ displayName })}
          autoCapitalize="words"
          maxLength={60}
        />
        <View style={styles.group}>
          <Segmented
            label="Sex"
            options={[
              { value: 'male', label: 'Male' },
              { value: 'female', label: 'Female' },
            ]}
            value={draft.sex}
            onChange={(sex) => set(sex === 'male' ? { sex, pregnant: false, lactating: false } : { sex })}
          />
          <AppText variant="small" muted>Used for resting energy formulas and nutrient guidelines.</AppText>
        </View>
        <BirthdateField
          value={draft.birthdate}
          onChange={(birthdate) => set({ birthdate })}
          error={dirty ? errors.birthdate : null}
        />
        <UnitToggle
          value={draft.unitSystem}
          onChange={(unitSystem) =>
            set({ unitSystem, height: convertHeightInput(draft.height, draft.unitSystem, unitSystem) })
          }
        />
        <HeightFields
          value={draft.height}
          onChange={(h) => set({ height: h })}
          system={draft.unitSystem}
          error={dirty ? errors.height : null}
        />
        {draft.sex === 'female' ? (
          <View style={styles.group}>
            <SwitchRow
              label="Pregnant"
              description="Uses pregnancy nutrient guidelines."
              value={draft.pregnant}
              onChange={(pregnant) => set({ pregnant })}
            />
            <SwitchRow
              label="Breastfeeding"
              description="Uses lactation nutrient guidelines."
              value={draft.lactating}
              onChange={(lactating) => set({ lactating })}
            />
          </View>
        ) : null}
        <SaveRow
          label="Save details"
          onPress={onSave}
          dirty={dirty}
          valid={valid}
          loading={update.isPending}
          saved={update.isSuccess}
          error={update.error}
        />
      </Card>
      <LogWeightCard profile={profile} />
      <Card>
        <AppText variant="heading">Targets</AppText>
        <AppText variant="small" muted>
          Activity level, goal, macros and BMR settings live under Profile & targets.
        </AppText>
        <Button label="Open Profile & targets" variant="secondary" onPress={() => router.push('/settings/targets')} />
      </Card>
    </>
  );
}

export default function ProfileScreen() {
  const { colors } = useTheme();
  const profileQ = useProfile();
  const profile = profileQ.data;
  return (
    <Screen>
      <Stack.Screen options={{ headerShown: true, title: 'Personal details' }} />
      {profileQ.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} accessibilityLabel="Loading profile" />
        </View>
      ) : profile ? (
        <ProfileEditor profile={profile} />
      ) : (
        <Card>
          <AppText variant="heading">No profile yet</AppText>
          <AppText muted>Complete the setup to create your profile.</AppText>
          <Button label="Start setup" onPress={() => router.push('/onboarding')} />
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { paddingVertical: spacing.xxl, alignItems: 'center' },
  group: { gap: spacing.sm },
});
