import {
  formatHeight,
  formatWeight,
  MACRO_PRESET_MODES,
  type MacroPresetId,
  type ResolvedTargetsCore,
} from '@ration/core';
import { StyleSheet, View } from 'react-native';

import { NumberField, Segmented, SwitchRow } from '@/components/forms';
import { AppText, Card } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

import { BirthdateField, HeightFields, UnitToggle } from './body-fields';
import { EnergyBreakdownTable, MacroSummaryTable } from './energy-breakdown';
import { GoalEditor } from './goal-editor';
import { convertGoalDraft } from './goal-draft';
import {
  convertHeightInput,
  convertWeightInput,
  weightUnitLabel,
} from './inputs';
import { draftFromPreset, matchingPreset } from './macro-draft';
import { MacroEditor } from './macro-editor';
import type { OnboardingForm, ParsedOnboarding } from './onboarding-model';
import { ACTIVITY_NOTE, ACTIVITY_OPTIONS, MEDICAL_DISCLAIMER, activityBoost } from './options';
import { OptionList } from './option-list';
import { Chip, Note } from './rows';

export interface StepProps {
  form: OnboardingForm;
  update: (patch: Partial<OnboardingForm>) => void;
  parsed: ParsedOnboarding;
  /** Show validation messages (after the user pressed Next once). */
  showErrors: boolean;
}

function ErrorText({ message }: { message?: string | null }) {
  const { colors } = useTheme();
  if (!message) return null;
  return <AppText variant="small" style={{ color: colors.danger }}>{message}</AppText>;
}

// ------------------------------------------------------------------- step 1

export function StepBasics({ form, update, parsed, showErrors }: StepProps) {
  const changeUnits = (to: OnboardingForm['unitSystem']) =>
    update({
      unitSystem: to,
      height: convertHeightInput(form.height, form.unitSystem, to),
      weight: convertWeightInput(form.weight, form.unitSystem, to),
      goal: convertGoalDraft(form.goal, form.unitSystem, to),
    });

  return (
    <Card>
      <UnitToggle value={form.unitSystem} onChange={changeUnits} />
      <View style={styles.group}>
        <Segmented
          label="Sex"
          options={[
            { value: 'male', label: 'Male' },
            { value: 'female', label: 'Female' },
          ]}
          value={form.sex}
          onChange={(sex) => update(sex === 'male' ? { sex, pregnant: false, lactating: false } : { sex })}
        />
        <AppText variant="small" muted>
          Used for resting energy formulas and nutrient guidelines.
        </AppText>
        {showErrors ? <ErrorText message={parsed.errors.sex} /> : null}
      </View>
      <BirthdateField
        value={form.birthdate}
        onChange={(birthdate) => update({ birthdate })}
        error={showErrors ? parsed.errors.birthdate : null}
      />
      <HeightFields
        value={form.height}
        onChange={(height) => update({ height })}
        system={form.unitSystem}
        error={showErrors ? parsed.errors.height : null}
      />
      {form.sex === 'female' ? (
        <View style={styles.group}>
          <SwitchRow
            label="Pregnant"
            description="Uses pregnancy nutrient guidelines."
            value={form.pregnant}
            onChange={(pregnant) => update({ pregnant })}
          />
          <SwitchRow
            label="Breastfeeding"
            description="Uses lactation nutrient guidelines."
            value={form.lactating}
            onChange={(lactating) => update({ lactating })}
          />
        </View>
      ) : null}
    </Card>
  );
}

// ------------------------------------------------------------------- step 2

export function StepWeight({ form, update, parsed, showErrors }: StepProps) {
  return (
    <Card>
      <NumberField
        label="Current weight"
        unit={weightUnitLabel(form.unitSystem)}
        value={form.weight}
        onChange={(weight) => update({ weight })}
        error={showErrors ? parsed.errors.weight : null}
      />
      <NumberField
        label="Body fat (optional)"
        unit="%"
        value={form.bodyFat}
        onChange={(bodyFat) => update({ bodyFat })}
        error={showErrors ? parsed.errors.bodyFat : null}
        hint="If you know it, you can use lean-mass formulas (Katch-McArdle, Cunningham) for a more tailored estimate."
      />
    </Card>
  );
}

// ------------------------------------------------------------------- step 3

export function StepActivity({ form, update }: StepProps) {
  return (
    <Card>
      <OptionList
        label="Typical day"
        value={form.activity}
        onChange={(activity) => update({ activity })}
        options={ACTIVITY_OPTIONS.map((o) => ({
          value: o.value,
          label: o.label,
          description: `${o.description} (${activityBoost(o.value)})`,
        }))}
      />
      <Note>{ACTIVITY_NOTE}</Note>
    </Card>
  );
}

// ------------------------------------------------------------------- step 4

export function StepGoal({
  form,
  update,
  parsed,
  result,
}: StepProps & { result: ResolvedTargetsCore | null }) {
  return (
    <Card>
      <GoalEditor
        draft={form.goal}
        onChange={(goal) => update({ goal })}
        unitSystem={form.unitSystem}
        weightKg={parsed.weightKg ?? 70}
        result={result}
      />
    </Card>
  );
}

// ------------------------------------------------------------------- step 5

const PRESETS: { id: MacroPresetId; label: string; description: string }[] = [
  { id: 'balanced', label: 'Balanced', description: '30% protein, 40% carbs, 30% fat. A good all-round split.' },
  { id: 'high_protein', label: 'High protein', description: '40% protein, 30% carbs, 30% fat. Helpful for building or keeping muscle.' },
  { id: 'low_carb', label: 'Low carb', description: '30% protein, 20% carbs, 50% fat.' },
  {
    id: 'keto',
    label: 'Keto',
    description: `Net carbs capped at ${MACRO_PRESET_MODES.keto.netCarbsG} g, protein from your lean mass, fat fills the rest.`,
  },
];

export function StepMacros({
  form,
  update,
  parsed,
  result,
}: StepProps & { result: ResolvedTargetsCore | null }) {
  const active = matchingPreset(form.macro);
  const activeDef = PRESETS.find((p) => p.id === active);
  return (
    <Card>
      <View style={styles.chips} accessibilityLabel="Macro style presets">
        {PRESETS.map((p) => (
          <Chip
            key={p.id}
            label={p.label}
            selected={active === p.id}
            onPress={() => update({ macro: draftFromPreset(p.id) })}
          />
        ))}
      </View>
      <AppText variant="small" muted>
        {activeDef ? activeDef.description : 'Custom: fine-tune the split below.'}
      </AppText>
      {result && parsed.weightKg !== null ? (
        <MacroEditor
          draft={form.macro}
          onChange={(macro) => update({ macro })}
          energyKcal={result.energy.target}
          weightKg={parsed.weightKg}
          bodyFatPct={parsed.bodyFatPct}
          netCarbs={form.netCarbs}
        />
      ) : null}
    </Card>
  );
}

// ------------------------------------------------------------------- step 6

export function StepSummary({
  form,
  parsed,
  result,
}: StepProps & { result: ResolvedTargetsCore | null }) {
  if (!result || parsed.weightKg === null || parsed.heightCm === null) {
    return <Note tone="danger">Some details are missing. Go back and complete the earlier steps.</Note>;
  }
  const carbsLabel = form.netCarbs || result.macroMode.mode === 'keto' ? 'Net Carbs' : 'Carbs';
  return (
    <>
      <Card>
        <AppText variant="heading">Energy target</AppText>
        <EnergyBreakdownTable result={result} unitSystem={form.unitSystem} />
        {result.exceedsSafeLossRate || result.energy.flooredBy > 0 || result.energy.belowBmr ? (
          <Note tone="warning">
            Your goal is aggressive. You can go back to the goal step and choose a slower pace.
          </Note>
        ) : null}
      </Card>
      <Card>
        <AppText variant="heading">Macro targets</AppText>
        <MacroSummaryTable macros={result.macros} carbsLabel={carbsLabel} />
        {result.macroError ? <Note tone="danger">{result.macroError}</Note> : null}
      </Card>
      <Card>
        <AppText variant="heading">Your details</AppText>
        <AppText variant="small" muted>
          {`${form.sex === 'female' ? 'Female' : 'Male'}, ${result.age} years, ${formatHeight(parsed.heightCm, form.unitSystem)}, ${formatWeight(parsed.weightKg, form.unitSystem)}${parsed.bodyFatPct !== null ? `, ${parsed.bodyFatPct}% body fat` : ''}.`}
        </AppText>
      </Card>
      <Note>{MEDICAL_DISCLAIMER}</Note>
    </>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
