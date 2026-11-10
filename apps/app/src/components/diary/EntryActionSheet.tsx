import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { deriveNutrients, parseNumber, scaleNutrients } from '@cal/core';

import { formatNumber } from '@/components/charts/format';
import { amountWarning } from '@/components/food/serving';
import { AmountWarningNote } from '@/components/food/serving-picker';
import { NumberField } from '@/components/forms';
import { AppText, Button } from '@/components/ui';
import {
  useDeleteDiaryEntry,
  useDiaryEntries,
  useMoveDiaryEntry,
  useUpdateDiaryEntry,
  type DiaryEntry,
} from '@/data/diary';
import { isPastDate } from '@/data/diary-copy';
import type { MealGroup } from '@/data/meal-groups';
import { supabase } from '@/lib/supabase';
import { todayISO } from '@/state/selected-date';
import { radius, spacing, useTheme } from '@/theme';

import { entryCopyActions } from './copy-menus';
import { haptic } from './haptics';
import { Sheet } from './Sheet';
import type { CopyActions } from './use-copy-actions';

interface PortionRow {
  label: string;
  amount: number | null;
  unit: string | null;
  grams: number;
}

interface UnitOption {
  key: string;
  label: string;
  /** Grams of ONE unit. */
  gramsPerUnit: number;
}

const GRAM_UNIT: UnitOption = { key: 'g', label: 'g', gramsPerUnit: 1 };

/** Named portions of a food (food_portions), as selectable units. */
function useFoodPortions(foodId: string | undefined) {
  return useQuery({
    queryKey: ['food_portions', foodId],
    enabled: Boolean(foodId),
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<PortionRow[]> => {
      const { data, error } = await supabase
        .from('food_portions')
        .select('label,amount,unit,grams,sort_order')
        .eq('food_id', foodId as string)
        .order('sort_order', { ascending: true });
      if (error) throw error;
      return (data ?? []) as PortionRow[];
    },
  });
}

function toUnits(portions: readonly PortionRow[]): UnitOption[] {
  const seen = new Set<string>(['g']);
  const units: UnitOption[] = [GRAM_UNIT];
  portions.forEach((p, i) => {
    const grams = Number(p.grams);
    if (!(grams > 0)) return;
    const label = (p.unit?.trim() || p.label).trim();
    if (!label || seen.has(label.toLowerCase())) return;
    seen.add(label.toLowerCase());
    units.push({ key: `p${i}`, label, gramsPerUnit: grams / (Number(p.amount) > 0 ? Number(p.amount) : 1) });
  });
  return units;
}

const trimText = (n: number) => formatNumber(n, n < 10 ? 2 : 1, true).replace(/,/g, '');

/**
 * Edit sheet for one diary entry: amount (grams or a portion), move to another meal group, copy / paste (clipboard,
 * today), delete (with confirm).
 * The entry is looked up live so optimistic changes (e.g. move) show up immediately.
 */
export function EntryActionSheet({
  entryId,
  date,
  groups,
  copyActions,
  onClose,
}: {
  entryId: string | null;
  date: string;
  groups: MealGroup[];
  /** Copy / paste actions of the diary (they outlive this sheet, which unmounts its body when closed). */
  copyActions: CopyActions;
  onClose: () => void;
}) {
  const entries = useDiaryEntries(date);
  const entry = entryId ? entries.data?.find((e) => e.id === entryId) : undefined;
  // Keep showing the last entry while the sheet is open (it disappears from the list right after delete).
  return (
    <Sheet visible={entryId !== null && entry !== undefined} onClose={onClose} title={entry?.food.name} subtitle={entry?.food.brand ?? undefined}>
      {entry ? <EntryEditor key={entry.id} entry={entry} groups={groups} copyActions={copyActions} onClose={onClose} /> : null}
    </Sheet>
  );
}

function EntryEditor({
  entry,
  groups,
  copyActions,
  onClose,
}: {
  entry: DiaryEntry;
  groups: MealGroup[];
  copyActions: CopyActions;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const portionsQ = useFoodPortions(entry.foodId);
  const units = useMemo(() => toUnits(portionsQ.data ?? []), [portionsQ.data]);

  const update = useUpdateDiaryEntry();
  const move = useMoveDiaryEntry();
  const remove = useDeleteDiaryEntry();
  const copyLabels = entryCopyActions({
    isPastDate: isPastDate(entry.entryDate, todayISO()),
    clipboard: copyActions.clipboard,
  });
  const groupName = groups.find((g) => g.id === entry.mealGroupId)?.name ?? 'the diary';

  // Edits are stored as overrides; until the user edits, values are DERIVED from the entry and the loaded
  // portions (portion entries show in their own unit once portions load) - no state syncing in effects.
  const [unitOverride, setUnitOverride] = useState<string | null>(null);
  const [textOverride, setTextOverride] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const portionMatch = useMemo(() => {
    if (!entry.amount || !entry.portionLabel) return null;
    const label = entry.portionLabel.trim().toLowerCase();
    const match = units.find((u) => u.label.toLowerCase() === label);
    return match && match.key !== 'g' ? match : null;
  }, [units, entry.amount, entry.portionLabel]);

  const unitKey = unitOverride ?? portionMatch?.key ?? 'g';
  const text = textOverride ?? (portionMatch ? trimText(entry.amount ?? entry.grams) : trimText(entry.grams));

  const unit = units.find((u) => u.key === unitKey) ?? GRAM_UNIT;
  const amount = parseNumber(text);
  const grams = amount === null ? null : amount * unit.gramsPerUnit;
  const valid = grams !== null && grams > 0 && grams <= 100_000;
  const changed = valid && (Math.abs(grams - entry.grams) > 0.0005 || (unit.key !== 'g') !== Boolean(entry.portionLabel && entry.amount));

  const preview = useMemo(() => {
    if (!valid || grams === null) return undefined;
    return deriveNutrients(scaleNutrients(entry.food.nutrients, grams), { carbBasis: entry.food.carbBasis });
  }, [valid, grams, entry.food.nutrients, entry.food.carbBasis]);

  // Non-blocking: 200 x a 174 g portion is 34.8 kg - offer to read the typed number as grams.
  const warning = amountWarning({ grams, kcal: preview?.ENERGY_KCAL, amount, inGrams: unit.key === 'g' });

  const selectUnit = (next: UnitOption) => {
    haptic('selection');
    const currentGrams = grams ?? entry.grams;
    setUnitOverride(next.key);
    setTextOverride(trimText(currentGrams / next.gramsPerUnit));
  };

  const save = () => {
    if (!valid || grams === null || amount === null) return;
    haptic('success');
    update.mutate({
      id: entry.id,
      entryDate: entry.entryDate,
      grams,
      amount: unit.key === 'g' ? null : amount,
      portionLabel: unit.key === 'g' ? null : unit.label,
    });
    onClose();
  };

  const moveTo = (group: MealGroup) => {
    if (group.id === entry.mealGroupId) return;
    haptic('selection');
    move.mutate({ id: entry.id, entryDate: entry.entryDate, mealGroupId: group.id });
  };

  const doDelete = () => {
    haptic('warning');
    remove.mutate({ id: entry.id, entryDate: entry.entryDate });
    onClose();
  };

  const copyEntry = () => {
    haptic('light');
    copyActions.copyToClipboard({ kind: 'entry', label: entry.food.name, sourceGroupId: entry.mealGroupId, entries: [entry] });
    onClose();
  };

  const pasteHere = () => {
    haptic('light');
    onClose();
    void copyActions.pasteClipboard(entry.mealGroupId, groupName);
  };

  const copyToToday = () => {
    haptic('light');
    onClose();
    void copyActions.copyEntryToToday(entry);
  };

  const stat = (label: string, value: number | undefined, suffix: string, decimals = 0) => (
    <View style={styles.stat} accessible accessibilityLabel={`${label} ${value === undefined ? 'unknown' : `${formatNumber(value, decimals, true)} ${suffix}`}`}>
      <AppText variant="small" muted>
        {label}
      </AppText>
      <AppText style={{ fontWeight: '700' }}>{value === undefined ? '-' : `${formatNumber(value, decimals, true)}${suffix}`}</AppText>
    </View>
  );

  return (
    <>
      <NumberField
        label="Amount"
        unit={unit.label}
        value={text}
        onChange={(t) => {
          setUnitOverride(unitKey); // freeze the unit so late-loading portions don't change it under the user
          setTextOverride(t);
        }}
        error={text.trim() !== '' && !valid ? 'Enter an amount above 0' : null}
        hint={valid && grams !== null && unit.key !== 'g' ? `= ${formatNumber(grams, 1, true)} g` : undefined}
        selectTextOnFocus
        returnKeyType="done"
        onSubmitEditing={save}
      />

      {units.length > 1 ? (
        <View style={styles.block}>
          <AppText variant="label" muted>
            Unit
          </AppText>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            {units.map((u) => (
              <Chip key={u.key} label={u.label} selected={u.key === unitKey} onPress={() => selectUnit(u)} />
            ))}
          </ScrollView>
        </View>
      ) : null}

      {warning ? (
        <AmountWarningNote
          warning={warning}
          onUseGrams={() => {
            haptic('selection');
            setUnitOverride('g');
            setTextOverride(text);
          }}
        />
      ) : null}

      <View style={[styles.preview, { backgroundColor: colors.surfaceAlt }]}>
        {stat('Energy', preview?.ENERGY_KCAL, ' kcal')}
        {stat('Protein', preview?.PROTEIN_G, ' g', 1)}
        {stat('Carbs', preview?.CARBS_G, ' g', 1)}
        {stat('Fat', preview?.FAT_G, ' g', 1)}
      </View>

      {groups.length > 0 ? (
        <View style={styles.block}>
          <AppText variant="label" muted>
            Meal
          </AppText>
          <View style={styles.chipsWrap}>
            {groups.map((g) => (
              <Chip key={g.id} label={g.name} selected={g.id === entry.mealGroupId} onPress={() => moveTo(g)} />
            ))}
          </View>
        </View>
      ) : null}

      <Button label="Save" onPress={save} disabled={!changed} />

      <View style={styles.block}>
        <AppText variant="label" muted>
          Copy
        </AppText>
        <View style={styles.chipsWrap}>
          <Chip label={copyLabels.copy} onPress={copyEntry} />
          {copyLabels.paste ? <Chip label={copyLabels.paste} onPress={pasteHere} /> : null}
          {copyLabels.copyToToday ? <Chip label={copyLabels.copyToToday} onPress={copyToToday} /> : null}
        </View>
      </View>

      {confirmDelete ? (
        <View style={[styles.confirm, { borderColor: colors.danger }]}>
          <AppText style={{ fontWeight: '600' }}>Delete this entry?</AppText>
          <View style={styles.confirmButtons}>
            <View style={styles.flex}>
              <Button label="Keep" variant="secondary" onPress={() => setConfirmDelete(false)} />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Confirm delete"
              onPress={doDelete}
              style={[styles.deleteConfirm, { backgroundColor: colors.danger }]}>
              <AppText style={{ color: colors.onPrimary, fontWeight: '700', fontSize: 15 }}>Delete</AppText>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            haptic('light');
            setConfirmDelete(true);
          }}
          style={styles.deleteLink}>
          <AppText style={{ color: colors.danger, fontWeight: '700' }}>Delete entry</AppText>
        </Pressable>
      )}
    </>
  );
}

/** Pill button. `selected` marks a choice; omit it for a plain action. */
function Chip({ label, selected, onPress }: { label: string; selected?: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      style={[
        styles.chip,
        { backgroundColor: selected === true ? colors.primary : colors.surfaceAlt, borderColor: selected === true ? colors.primary : colors.border },
      ]}>
      <AppText style={{ fontSize: 14, fontWeight: '600', color: selected === true ? colors.onPrimary : colors.text }}>{label}</AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  block: { gap: spacing.xs },
  chips: { gap: spacing.sm },
  chipsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    minHeight: 38,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  preview: { flexDirection: 'row', justifyContent: 'space-between', padding: spacing.md, borderRadius: radius.md },
  stat: { alignItems: 'center', gap: 2, flex: 1 },
  deleteLink: { alignItems: 'center', justifyContent: 'center', minHeight: 44 },
  confirm: { borderWidth: 1, borderRadius: radius.md, padding: spacing.md, gap: spacing.md },
  confirmButtons: { flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
  flex: { flex: 1 },
  deleteConfirm: { flex: 1, minHeight: 46, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
});
