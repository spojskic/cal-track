import { formatWeight, type MacroMode, type ResolveTargetsInput, type UnitSystem } from '@cal/core';
import { Stack, router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { NumberField, SwitchRow } from '@/components/forms';
import { EnergyBreakdownTable } from '@/components/settings/energy-breakdown';
import {
  energyDraftEqual,
  energyDraftFromProfile,
  energyDraftToPatch,
  parseManualBmr,
  type EnergyDraft,
} from '@/components/settings/energy-draft';
import { formatInt } from '@/components/settings/format';
import { GoalEditor } from '@/components/settings/goal-editor';
import {
  goalDraftFromSaved,
  goalDraftValues,
  type GoalDraft,
} from '@/components/settings/goal-draft';
import { safeResolve } from '@/components/settings/inputs';
import { draftFromMode, draftToMode, type MacroDraft } from '@/components/settings/macro-draft';
import { MacroEditor, previewMacroDraft } from '@/components/settings/macro-editor';
import { OptionList } from '@/components/settings/option-list';
import {
  ACTIVITY_NOTE,
  ACTIVITY_OPTIONS,
  BMR_FORMULA_OPTIONS,
  ENERGY_MODE_OPTIONS,
  activityBoost,
  bmrFormulaLabel,
} from '@/components/settings/options';
import { CollapsibleHeader, Divider, NavRow, Note } from '@/components/settings/rows';
import { SaveRow } from '@/components/settings/save-row';
import { AppText, Button, Card, Screen } from '@/components/ui';
import { useActiveWeightGoal, useSaveMacroTarget, useSaveWeightGoal, type WeightGoal } from '@/data/goals';
import { useProfile, useUpdateProfile } from '@/data/profile';
import { useTargets, type ResolvedTargets } from '@/data/targets';
import { todayISO } from '@/state/selected-date';
import { spacing, useTheme } from '@/theme';

function TargetsEditor({ targets, goal }: { targets: ResolvedTargets; goal: WeightGoal | null }) {
  const { colors } = useTheme();
  const { profile, weightKg, bodyFatPct } = targets;
  const unitSystem: UnitSystem = profile.unit_system;

  // Drafts hold only what the user edited; null means "show the saved value".
  const savedEnergy = energyDraftFromProfile(profile);
  const savedGoal = goalDraftFromSaved(goal, unitSystem);
  const savedMacro = draftFromMode(targets.macroMode, targets.macros);
  const [energyEdit, setEnergyEdit] = useState<EnergyDraft | null>(null);
  const [goalEdit, setGoalEdit] = useState<GoalDraft | null>(null);
  const [macroEdit, setMacroEdit] = useState<MacroDraft | null>(null);
  const [showBreakdown, setShowBreakdown] = useState(true);
  const [showFormula, setShowFormula] = useState(false);
  const [showMode, setShowMode] = useState(false);

  const energy = energyEdit ?? savedEnergy;
  const goalDraft = goalEdit ?? savedGoal;
  const macroDraft = macroEdit ?? savedMacro;

  const saveProfile = useUpdateProfile();
  const saveGoal = useSaveWeightGoal();
  const saveMacro = useSaveMacroTarget();

  // ---- live preview from the drafts
  const manualBmr = parseManualBmr(energy.manualBmr);
  const goalValues = goalDraftValues(goalDraft, unitSystem, weightKg);
  const macroParsed = draftToMode(macroDraft);
  const rateKgPerWeek = goalValues.errors.rate ? targets.rateKgPerWeek : goalValues.rateKgPerWeek;
  const input: ResolveTargetsInput | null =
    profile.sex && profile.birthdate && profile.height_cm
      ? {
          sex: profile.sex,
          birthdate: profile.birthdate,
          heightCm: Number(profile.height_cm),
          weightKg,
          bodyFatPct,
          activityLevel: energy.activity,
          bmrFormula: energy.bmrFormula,
          bmrOverride: manualBmr.value,
          rateKgPerWeek,
          macroMode: macroParsed.mode,
          netCarbs: energy.netCarbs,
          pregnant: profile.pregnant,
          lactating: profile.lactating,
          onDate: todayISO(),
        }
      : null;
  const live = safeResolve(input);

  // ---- dirty / validity
  const energyDirty = energyEdit !== null && !energyDraftEqual(energyEdit, savedEnergy);
  const energyValid = energy.bmrFormula !== 'manual' || manualBmr.value !== null;
  const goalDirty = goalEdit !== null && JSON.stringify(goalEdit) !== JSON.stringify(savedGoal);
  const goalValid = !goalValues.errors.rate && !goalValues.errors.target;
  const macroPreview = live
    ? previewMacroDraft(macroDraft, live.energy.target, { weightKg, bodyFatPct })
    : null;
  const macroDirty =
    macroEdit !== null && JSON.stringify(draftToMode(macroEdit).mode) !== JSON.stringify(targets.macroMode);
  const macroValid = macroPreview?.mode != null;
  const anyDirty = energyDirty || goalDirty || macroDirty;

  const onSaveEnergy = () =>
    saveProfile.mutate(energyDraftToPatch(energy), { onSuccess: () => setEnergyEdit(null) });
  const onSaveGoal = () =>
    saveGoal.mutate(
      {
        rateKgPerWeek: goalValues.rateKgPerWeek,
        targetWeightKg: goalValues.targetWeightKg,
        startWeightKg: weightKg,
      },
      { onSuccess: () => setGoalEdit(null) },
    );
  const onSaveMacro = () => {
    const mode: MacroMode | null | undefined = macroPreview?.mode;
    if (!mode) return;
    saveMacro.mutate(mode, { onSuccess: () => setMacroEdit(null) });
  };

  const effectiveFormulaDiffers = live !== null && live.bmrFormula !== energy.bmrFormula;

  return (
    <>
      {/* ------------------------------------------------ Macro & Energy Targets */}
      <Card>
        <AppText variant="heading">Macro & Energy Targets</AppText>
        {live ? (
          <>
            <View accessible accessibilityLabel={`Energy target ${formatInt(live.energy.target)} kilocalories`}>
              <AppText variant="label" muted>Energy Target</AppText>
              <AppText variant="title" style={{ color: colors.energy }}>
                {formatInt(live.energy.target)} kcal
              </AppText>
            </View>
            {anyDirty ? (
              <Note tone="info">Preview: the numbers below include changes you have not saved yet.</Note>
            ) : null}
            <CollapsibleHeader
              label="Target breakdown"
              open={showBreakdown}
              onToggle={() => setShowBreakdown((v) => !v)}
            />
            {showBreakdown ? <EnergyBreakdownTable result={live} unitSystem={unitSystem} /> : null}
            <Divider />
            <AppText variant="heading">Set Macro Targets</AppText>
            <MacroEditor
              draft={macroDraft}
              onChange={setMacroEdit}
              energyKcal={live.energy.target}
              weightKg={weightKg}
              bodyFatPct={bodyFatPct}
              netCarbs={energy.netCarbs}
            />
            <SaveRow
              label="Save macro targets"
              onPress={onSaveMacro}
              dirty={macroDirty}
              valid={macroValid}
              loading={saveMacro.isPending}
              saved={saveMacro.isSuccess}
              error={saveMacro.error}
            />
          </>
        ) : (
          <Note tone="danger">Targets could not be calculated from your details. Check your personal details.</Note>
        )}
      </Card>

      {/* ------------------------------------------------------------ Weight Goal */}
      <Card>
        <AppText variant="heading">Weight Goal</AppText>
        <AppText variant="small" muted>{`Current weight: ${formatWeight(weightKg, unitSystem)}`}</AppText>
        <GoalEditor
          draft={goalDraft}
          onChange={setGoalEdit}
          unitSystem={unitSystem}
          weightKg={weightKg}
          result={live}
        />
        <SaveRow
          label="Save weight goal"
          onPress={onSaveGoal}
          dirty={goalDirty}
          valid={goalValid}
          loading={saveGoal.isPending}
          saved={saveGoal.isSuccess}
          error={saveGoal.error}
        />
      </Card>

      {/* ------------------------------------------------------- Energy calculation */}
      <Card>
        <AppText variant="heading">Energy calculation</AppText>

        <OptionList
          label="Baseline activity level"
          value={energy.activity}
          onChange={(activity) => setEnergyEdit({ ...energy, activity })}
          options={ACTIVITY_OPTIONS.map((o) => ({
            value: o.value,
            label: `${o.label} (${activityBoost(o.value)})`,
            description: o.description,
          }))}
        />
        <AppText variant="small" muted>{ACTIVITY_NOTE}</AppText>

        <Divider />
        <CollapsibleHeader
          label={`BMR formula: ${bmrFormulaLabel(energy.bmrFormula)}`}
          open={showFormula}
          onToggle={() => setShowFormula((v) => !v)}
        />
        {showFormula ? (
          <>
            <OptionList
              value={energy.bmrFormula}
              onChange={(bmrFormula) => setEnergyEdit({ ...energy, bmrFormula })}
              options={BMR_FORMULA_OPTIONS.map((o) => ({
                value: o.value,
                label: o.label,
                description: o.description,
                disabled: o.needsBodyFat && bodyFatPct === null,
                disabledReason: 'Needs a body fat percentage. Log one under Personal details.',
              }))}
            />
            {energy.bmrFormula === 'manual' ? (
              <NumberField
                label="Resting energy (BMR)"
                unit="kcal/day"
                value={energy.manualBmr}
                onChange={(manualBmr) => setEnergyEdit({ ...energy, manualBmr })}
                error={energy.manualBmr.trim() !== '' ? manualBmr.error : null}
                hint="Without a valid value Mifflin-St Jeor is used."
              />
            ) : null}
          </>
        ) : null}
        {effectiveFormulaDiffers && live ? (
          <Note tone="warning">{`Currently calculating with ${bmrFormulaLabel(live.bmrFormula)} because the selected formula has no data to work with.`}</Note>
        ) : null}

        <Divider />
        <CollapsibleHeader
          label={`Energy mode: ${ENERGY_MODE_OPTIONS.find((o) => o.value === energy.energyMode)?.label ?? ''}`}
          open={showMode}
          onToggle={() => setShowMode((v) => !v)}
        />
        {showMode ? (
          <OptionList
            value={energy.energyMode}
            onChange={(energyMode) => setEnergyEdit({ ...energy, energyMode })}
            options={ENERGY_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label, description: o.description }))}
          />
        ) : null}

        <Divider />
        <SwitchRow
          label="Thermic effect of food (TEF)"
          description="Counts about 10% of the calories you eat as energy spent digesting food in your daily energy balance. It does not change your energy target."
          value={energy.tef}
          onChange={(tef) => setEnergyEdit({ ...energy, tef })}
        />
        <SwitchRow
          label="Net carbs"
          description="Track carbohydrates as net carbs (minus fiber and sugar alcohols) and use that for your carb target."
          value={energy.netCarbs}
          onChange={(netCarbs) => setEnergyEdit({ ...energy, netCarbs })}
        />
        <SaveRow
          label="Save energy settings"
          onPress={onSaveEnergy}
          dirty={energyDirty}
          valid={energyValid}
          loading={saveProfile.isPending}
          saved={saveProfile.isSuccess}
          error={saveProfile.error}
        />
      </Card>

      <Card>
        <NavRow
          label="Personal details"
          description="Sex, birthdate, height, units, log your weight"
          onPress={() => router.push('/settings/profile')}
        />
        <Divider />
        <NavRow
          label="Nutrient targets"
          description="Vitamins, minerals and other daily targets"
          onPress={() => router.push('/settings/nutrients')}
        />
      </Card>
    </>
  );
}

export default function TargetsScreen() {
  const { colors } = useTheme();
  const profileQ = useProfile();
  const targets = useTargets();
  const goalQ = useActiveWeightGoal();
  const loading = targets.isLoading || profileQ.isLoading || goalQ.isLoading;

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: true, title: 'Profile & targets' }} />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} accessibilityLabel="Loading targets" />
        </View>
      ) : targets.data ? (
        <TargetsEditor targets={targets.data} goal={goalQ.data ?? null} />
      ) : (
        <Card>
          <AppText variant="heading">Finish setting up</AppText>
          <AppText muted>
            {targets.needsOnboarding
              ? 'Tell us a few details about you to calculate your daily targets.'
              : 'Your targets are not available right now. Check your connection and try again.'}
          </AppText>
          {targets.needsOnboarding ? (
            <Button label="Set up targets" onPress={() => router.push('/onboarding')} />
          ) : null}
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { paddingVertical: spacing.xxl, alignItems: 'center' },
});
