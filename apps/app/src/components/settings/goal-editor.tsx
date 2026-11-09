import { formatWeight, type ResolvedTargetsCore, type UnitSystem } from '@cal/core';
import { StyleSheet, View } from 'react-native';

import { NumberField, Segmented } from '@/components/forms';
import { AppText } from '@/components/ui';
import { addDays, todayISO } from '@/state/selected-date';
import { spacing } from '@/theme';

import { formatKcal, formatShortDate } from './format';
import {
  RATE_PRESETS,
  defaultRateText,
  goalDraftValues,
  rateTextToKg,
  weeksToTarget,
  type GoalDraft,
  type GoalType,
} from './goal-draft';
import { weightUnitLabel } from './inputs';
import { Chip, Note } from './rows';

const TYPE_OPTIONS: { value: GoalType; label: string }[] = [
  { value: 'maintain', label: 'Maintain' },
  { value: 'lose', label: 'Lose' },
  { value: 'gain', label: 'Gain' },
];

/** Warnings for a resolved goal: unsafe rate, energy floor applied, target below BMR. */
export function GoalWarnings({ result, unitSystem }: { result: ResolvedTargetsCore; unitSystem: UnitSystem }) {
  const { energy } = result;
  return (
    <>
      {result.exceedsSafeLossRate ? (
        <Note tone="warning">
          {`This is faster than the commonly recommended maximum of about ${formatWeight(result.maxSafeLossRateKgPerWeek, unitSystem)} per week (1% of your body weight). Faster loss can cost muscle and is harder to sustain.`}
        </Note>
      ) : null}
      {energy.flooredBy > 0 ? (
        <Note tone="warning">
          {`At this rate your target would drop below ${formatKcal(energy.floor)} per day, the lowest we allow. It is set to ${formatKcal(energy.floor)}, so you would lose weight more slowly than planned.`}
        </Note>
      ) : null}
      {energy.belowBmr ? (
        <Note tone="danger">
          {`Your target of ${formatKcal(energy.target)} is below your estimated resting energy (BMR) of ${formatKcal(result.bmr)}. Eating this little for long is not recommended; consider a slower rate.`}
        </Note>
      ) : null}
    </>
  );
}

/**
 * Weight goal editor: maintain / lose / gain, weekly rate with presets, optional target weight.
 * `result` (resolved with the draft's rate) drives the safety warnings.
 */
export function GoalEditor({
  draft,
  onChange,
  unitSystem,
  weightKg,
  result,
}: {
  draft: GoalDraft;
  onChange: (next: GoalDraft) => void;
  unitSystem: UnitSystem;
  weightKg: number;
  result: ResolvedTargetsCore | null;
}) {
  const unit = weightUnitLabel(unitSystem);
  const values = goalDraftValues(draft, unitSystem, weightKg);
  const rateKg = rateTextToKg(draft.rate, unitSystem);

  const setType = (type: GoalType) => {
    if (type === draft.type) return;
    if (type === 'maintain') onChange({ ...draft, type });
    else onChange({ ...draft, type, rate: draft.type === 'maintain' || draft.rate === '' ? defaultRateText(type, unitSystem) : draft.rate });
  };

  let eta: string | null = null;
  if (values.targetWeightKg !== null && values.rateKgPerWeek !== 0) {
    const weeks = weeksToTarget(weightKg, values.targetWeightKg, values.rateKgPerWeek);
    if (weeks !== null) {
      eta = `About ${weeks} ${weeks === 1 ? 'week' : 'weeks'} to reach ${formatWeight(values.targetWeightKg, unitSystem)} (around ${formatShortDate(addDays(todayISO(), weeks * 7))}).`;
    }
  }

  return (
    <View style={styles.root}>
      <Segmented options={TYPE_OPTIONS} value={draft.type} onChange={setType} />
      {draft.type === 'maintain' ? (
        <AppText variant="small" muted>
          Your energy target equals your estimated maintenance, so your weight should stay about the same.
        </AppText>
      ) : (
        <>
          <View style={styles.chips} accessibilityLabel="Weekly rate presets">
            {RATE_PRESETS[draft.type][unitSystem].map((preset) => {
              const selected = rateKg !== null && Math.abs((rateTextToKg(String(preset), unitSystem) ?? -1) - rateKg) < 0.0005;
              return (
                <Chip
                  key={preset}
                  label={`${preset} ${unit}/wk`}
                  accessibilityLabel={`${preset} ${unit} per week`}
                  selected={selected}
                  onPress={() => onChange({ ...draft, rate: String(preset) })}
                />
              );
            })}
          </View>
          <NumberField
            label={draft.type === 'lose' ? 'Weight to lose per week' : 'Weight to gain per week'}
            unit={`${unit}/week`}
            value={draft.rate}
            onChange={(rate) => onChange({ ...draft, rate })}
            error={values.errors.rate ?? null}
          />
          <NumberField
            label="Target weight (optional)"
            unit={unit}
            value={draft.target}
            onChange={(target) => onChange({ ...draft, target })}
            error={values.errors.target ?? null}
            hint={`Current weight: ${formatWeight(weightKg, unitSystem)}`}
          />
          {eta ? <AppText variant="small" muted>{eta}</AppText> : null}
          {result && !values.errors.rate ? <GoalWarnings result={result} unitSystem={unitSystem} /> : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
