// Sheets of the diary meal group menu: save the group's entries as a meal, or log a saved meal into the group.
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { formatNumber } from '@/components/charts/format';
import { haptic } from '@/components/diary/haptics';
import { runAfterModal, Sheet } from '@/components/diary/Sheet';
import { formatDayLabel } from '@/components/food/format';
import { TextField } from '@/components/forms';
import { AppText, Button } from '@/components/ui';
import type { DiaryEntry } from '@/data/diary';
import { errorMessage } from '@/data/foods';
import { useCreateSavedMeal, useLogSavedMeal, useSavedMeals } from '@/data/saved-meals';
import { useSelectedDate } from '@/state/selected-date';
import { radius, spacing, useTheme } from '@/theme';

import { open } from './nav';

/**
 * "Add a saved meal to <group>...": lists the saved meals and logs the chosen one into the meal group on the viewed
 * date. Opened from the "..." menu of a diary meal group.
 */
export function AddSavedMealSheet({
  visible,
  name,
  mealGroupId,
  onClose,
}: {
  visible: boolean;
  name: string;
  mealGroupId: string | undefined;
  onClose: () => void;
}) {
  const date = useSelectedDate((s) => s.date);
  return (
    <Sheet visible={visible} onClose={onClose} title="Add a saved meal" subtitle={`To ${name} \u00B7 ${formatDayLabel(date)}`}>
      {visible && mealGroupId ? <AddBody date={date} mealGroupId={mealGroupId} onClose={onClose} /> : null}
    </Sheet>
  );
}

/** "Create Meal from Group": names the meal and saves the group's foods (in grams) as a saved meal. */
export function SaveMealSheet({
  visible,
  name,
  entries,
  onClose,
}: {
  visible: boolean;
  name: string;
  entries: DiaryEntry[];
  onClose: () => void;
}) {
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Save as meal"
      subtitle={`${entries.length} ${entries.length === 1 ? 'food' : 'foods'} from ${name}`}>
      {visible ? <SaveBody defaultName={name} entries={entries} onClose={onClose} /> : null}
    </Sheet>
  );
}

function SaveBody({ defaultName, entries, onClose }: { defaultName: string; entries: DiaryEntry[]; onClose: () => void }) {
  const { colors } = useTheme();
  const create = useCreateSavedMeal();
  const [name, setName] = useState(defaultName);
  const [savedId, setSavedId] = useState<string | null>(null);
  const kcal = entries.reduce((sum, e) => sum + (e.kcal ?? 0), 0);

  if (savedId) {
    return (
      <>
        <AppText accessibilityLiveRegion="polite" style={{ fontWeight: '600' }}>
          Saved as {'\u201C'}{name.trim()}{'\u201D'}.
        </AppText>
        <AppText variant="small" muted>Find it under Foods, Saved meals.</AppText>
        <Button label="Done" onPress={onClose} />
        <Button
          label="Open meal"
          variant="secondary"
          onPress={() => {
            onClose();
            runAfterModal(() => open('/saved-meal/[id]', { id: savedId }));
          }}
        />
      </>
    );
  }

  const save = () => {
    create.mutate(
      { name, items: entries.map((e) => ({ foodId: e.foodId, grams: e.grams })) },
      {
        onSuccess: (res) => {
          haptic('success');
          setSavedId(res.id);
        },
        onError: () => haptic('error'),
      },
    );
  };

  return (
    <>
      <TextField
        label="Meal name"
        value={name}
        onChangeText={setName}
        accessibilityLabel="Saved meal name"
        autoCapitalize="sentences"
        returnKeyType="done"
        onSubmitEditing={save}
        error={name.trim() === '' ? 'Give the meal a name' : null}
      />
      <AppText variant="small" muted>
        {entries.length} {entries.length === 1 ? 'food' : 'foods'}, {formatNumber(kcal)} kcal. Amounts are saved in grams.
      </AppText>
      {create.error ? (
        <AppText variant="small" style={{ color: colors.danger }} accessibilityLiveRegion="polite">
          {errorMessage(create.error)}
        </AppText>
      ) : null}
      <Button label="Save meal" onPress={save} loading={create.isPending} disabled={name.trim() === '' || entries.length === 0} />
    </>
  );
}

function AddBody({ date, mealGroupId, onClose }: { date: string; mealGroupId: string; onClose: () => void }) {
  const { colors } = useTheme();
  const meals = useSavedMeals();
  const log = useLogSavedMeal();
  const [busyId, setBusyId] = useState<string | null>(null);

  if (meals.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} accessibilityLabel="Loading saved meals" />
      </View>
    );
  }
  if (meals.error) {
    return (
      <>
        <AppText style={{ color: colors.danger }}>{errorMessage(meals.error)}</AppText>
        <Button label="Try again" variant="secondary" onPress={() => meals.refetch()} />
      </>
    );
  }
  const list = meals.data ?? [];
  if (list.length === 0) {
    return (
      <>
        <AppText muted>
          You have no saved meals yet. Use {'\u201C'}Save as a meal{'\u201D'} on a meal that has food in it, or build one from
          scratch.
        </AppText>
        <Button
          label="Create a saved meal"
          onPress={() => {
            onClose();
            runAfterModal(() => open('/saved-meal/new'));
          }}
        />
      </>
    );
  }

  return (
    <>
      {list.map((m) => (
        <Pressable
          key={m.id}
          accessibilityRole="button"
          accessibilityLabel={`${m.name}, ${m.items.length} ${m.items.length === 1 ? 'food' : 'foods'}, ${formatNumber(m.kcal)} kilocalories. Add to ${formatDayLabel(date)}`}
          disabled={log.isPending}
          onPress={() => {
            setBusyId(m.id);
            log.mutate(
              { savedMealId: m.id, date, mealGroupId },
              {
                onSuccess: () => {
                  haptic('success');
                  onClose();
                },
                onError: () => haptic('error'),
                onSettled: () => setBusyId(null),
              },
            );
          }}
          style={({ pressed }) => [
            styles.mealRow,
            { backgroundColor: colors.surfaceAlt, borderColor: colors.border, opacity: pressed || (log.isPending && busyId !== m.id) ? 0.7 : 1 },
          ]}>
          <View style={styles.flex}>
            <AppText style={{ fontWeight: '600' }} numberOfLines={2}>
              {m.name}
            </AppText>
            <AppText variant="small" muted>
              {m.items.length} {m.items.length === 1 ? 'food' : 'foods'} {'\u00B7'} {formatNumber(m.kcal)} kcal
            </AppText>
          </View>
          {busyId === m.id ? <ActivityIndicator color={colors.primary} /> : <AppText muted>{'+'}</AppText>}
        </Pressable>
      ))}
      {log.error ? (
        <AppText variant="small" style={{ color: colors.danger }} accessibilityLiveRegion="polite">
          {errorMessage(log.error)}
        </AppText>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', paddingVertical: spacing.lg },
  flex: { flex: 1 },
  mealRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
