import { flOzToMl, mlToFlOz, parseNumber, type UnitSystem } from '@ration/core';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import {
  DateBanner,
  DecimalField,
  FormScreen,
  QuickAmountChips,
  closeScreen,
  errorMessage,
  formatShortDate,
  formatVolume,
  hapticError,
  hapticLight,
  hapticSuccess,
  trimNum,
  useTargetDate,
  type ChipOption,
} from '@/components/activity';
import { AppText, Button, Card } from '@/components/ui';
import { useWaterMl } from '@/data/activity';
import { useAddWater, useUndoLastWater } from '@/data/activity-write';
import { useUnitSystem } from '@/data/profile';
import { todayISO } from '@/state/selected-date';
import { spacing, useTheme } from '@/theme';

const QUICK_ML = [250, 330, 500, 1000] as const;
const MAX_SINGLE_ML = 5000;
/** Nutrition-label cup used by @ration/core (240 mL). */
const ML_PER_CUP = 240;

type Feedback = { tone: 'success' | 'neutral' | 'error'; text: string };

function quickOptions(system: UnitSystem): ChipOption<number>[] {
  return QUICK_ML.map((ml) => {
    if (system === 'metric') return { value: ml, label: ml >= 1000 ? `${ml / 1000} L` : `${ml} mL` };
    const cups = ml / ML_PER_CUP;
    return {
      value: ml,
      label: `${trimNum(mlToFlOz(ml), 1)} fl oz`,
      sublabel: `~${trimNum(cups, 1)} ${trimNum(cups, 1) === '1' ? 'cup' : 'cups'}`,
    };
  });
}

export default function NewWaterScreen() {
  const { colors } = useTheme();
  const date = useTargetDate();
  const system = useUnitSystem();
  const imperial = system === 'imperial';

  const total = useWaterMl(date);
  const add = useAddWater();
  const undo = useUndoLastWater();

  const [customText, setCustomText] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  // Confirmation message fades after a moment; a new message restarts the timer.
  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), 2800);
    return () => clearTimeout(t);
  }, [feedback]);

  const addMl = async (ml: number): Promise<boolean> => {
    hapticLight();
    try {
      await add.mutateAsync({ entryDate: date, ml });
      hapticSuccess();
      setFeedback({ tone: 'success', text: `Added ${formatVolume(ml, system)}` });
      return true;
    } catch (e) {
      hapticError();
      setFeedback({ tone: 'error', text: errorMessage(e, 'Could not add water.') });
      return false;
    }
  };

  const addCustom = async () => {
    const v = parseNumber(customText);
    const ml = v === null ? null : imperial ? flOzToMl(v) : v;
    if (ml === null || !(ml > 0)) {
      setCustomError('Enter an amount above zero.');
      return;
    }
    if (ml > MAX_SINGLE_ML) {
      setCustomError(`That is more than ${formatVolume(MAX_SINGLE_ML, system)} at once. Check the number.`);
      return;
    }
    setCustomError(null);
    if (await addMl(Math.round(ml * 10) / 10)) setCustomText('');
  };

  const removeLast = async () => {
    try {
      const removed = await undo.mutateAsync({ entryDate: date });
      if (removed === null) {
        setFeedback({ tone: 'neutral', text: 'Nothing to remove.' });
      } else {
        hapticLight();
        setFeedback({ tone: 'neutral', text: `Removed ${formatVolume(removed, system)}` });
      }
    } catch (e) {
      hapticError();
      setFeedback({ tone: 'error', text: errorMessage(e, 'Could not remove the last entry.') });
    }
  };

  const feedbackColor =
    feedback?.tone === 'error' ? colors.danger : feedback?.tone === 'success' ? colors.success : colors.textMuted;
  const canRemove = !!total.data && total.data > 0 && !undo.isPending;

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Add water' }} />
      <FormScreen>
        <DateBanner date={date} />

        <Card>
          <AppText variant="label" muted>
            {date === todayISO() ? "Today's total" : `Total for ${formatShortDate(date)}`}
          </AppText>
          {total.isLoading ? (
            <ActivityIndicator accessibilityLabel="Loading water total" color={colors.primary} style={styles.loader} />
          ) : total.isError ? (
            <AppText variant="small" style={{ color: colors.danger }}>Could not load the total. Adding still works.</AppText>
          ) : (
            <AppText variant="title" accessibilityLiveRegion="polite">
              {formatVolume(total.data ?? 0, system)}
            </AppText>
          )}
          <View style={styles.feedbackRow}>
            {feedback ? (
              <AppText
                variant="body"
                accessibilityLiveRegion="polite"
                accessibilityRole={feedback.tone === 'error' ? 'alert' : undefined}
                style={{ color: feedbackColor, fontWeight: '600' }}>
                {feedback.text}
              </AppText>
            ) : null}
          </View>
        </Card>

        <QuickAmountChips
          label="Tap to add"
          tile
          options={quickOptions(system)}
          onSelect={(ml) => void addMl(ml)}
        />

        <Card>
          <DecimalField
            label="Custom amount"
            unit={imperial ? 'fl oz' : 'mL'}
            value={customText}
            onChange={(t) => {
              setCustomText(t);
              if (customError) setCustomError(null);
            }}
            placeholder={imperial ? '12' : '400'}
            returnKeyType="done"
            onSubmitEditing={() => void addCustom()}
            error={customError}
          />
          <Button label="Add custom amount" variant="secondary" onPress={() => void addCustom()} disabled={customText.trim() === ''} />
        </Card>

        <View style={styles.actions}>
          <Button label="Remove last" variant="secondary" onPress={() => void removeLast()} loading={undo.isPending} disabled={!canRemove} />
          <Button label="Done" onPress={closeScreen} />
        </View>
      </FormScreen>
    </>
  );
}

const styles = StyleSheet.create({
  loader: { alignSelf: 'flex-start', marginVertical: spacing.sm },
  feedbackRow: { minHeight: 24, justifyContent: 'center' },
  actions: { gap: spacing.sm },
});
