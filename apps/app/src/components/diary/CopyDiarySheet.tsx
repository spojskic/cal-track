import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { formatNumber } from '@/components/charts/format';
import { AppText, Button } from '@/components/ui';
import { useCopyDiaryEntries, useDiaryEntries } from '@/data/diary';
import { addDays } from '@/state/selected-date';
import { radius, spacing, useTheme } from '@/theme';

import { formatDayLabel, relativeDayLabel } from './dates';
import { haptic } from './haptics';
import { IconButton } from './IconButton';
import { Sheet } from './Sheet';
import type { CopyActions } from './use-copy-actions';

/**
 * Copy a meal group (or a whole day) from another date into `targetDate`.
 * The source day is picked with a prev/next stepper and previewed before copying.
 */
export function CopyDiarySheet({
  visible,
  targetDate,
  group,
  announceCopy,
  onClose,
}: {
  visible: boolean;
  targetDate: string;
  /** Copy just this meal group (same group on the source day -> this group). Omit for the whole day. */
  group?: { id: string; name: string } | null;
  /** Announces the finished copy with an Undo toast (from the diary's copy actions, which outlive this sheet). */
  announceCopy: CopyActions['announceCopy'];
  onClose: () => void;
}) {
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={group ? `Copy ${group.name} from...` : 'Copy a day from...'}
      subtitle={`Into ${formatDayLabel(targetDate)}`}>
      {visible ? (
        <CopyBody
          key={`${targetDate}-${group?.id ?? 'day'}`}
          targetDate={targetDate}
          group={group}
          announceCopy={announceCopy}
          onClose={onClose}
        />
      ) : null}
    </Sheet>
  );
}

function CopyBody({
  targetDate,
  group,
  announceCopy,
  onClose,
}: {
  targetDate: string;
  group?: { id: string; name: string } | null;
  announceCopy: CopyActions['announceCopy'];
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const [sourceDate, setSourceDate] = useState(addDays(targetDate, -1));
  const source = useDiaryEntries(sourceDate);
  const copy = useCopyDiaryEntries();

  const items = (source.data ?? []).filter((e) => !group || e.mealGroupId === group.id);
  const kcal = items.reduce((s, e) => s + (e.kcal ?? 0), 0);
  const sameDay = sourceDate === targetDate;
  const relative = relativeDayLabel(sourceDate);
  const scopeLabel = group ? group.name : 'day';

  const doCopy = async () => {
    try {
      const outcome = await copy.mutateAsync({
        fromDate: sourceDate,
        toDate: targetDate,
        fromMealGroupId: group?.id,
      });
      if (outcome.count > 0) {
        announceCopy(outcome, group?.name ?? relativeDayLabel(targetDate) ?? formatDayLabel(targetDate));
        onClose();
      } else {
        haptic('warning');
      }
    } catch {
      haptic('error');
    }
  };

  return (
    <>
      <View style={[styles.stepper, { backgroundColor: colors.surfaceAlt }]}>
        <IconButton glyph="‹" label="Earlier source day" onPress={() => setSourceDate((d) => addDays(d, -1))} />
        <View style={styles.stepperDate}>
          <AppText style={{ fontWeight: '700' }}>{formatDayLabel(sourceDate)}</AppText>
          {relative ? (
            <AppText variant="small" muted>
              {relative}
            </AppText>
          ) : null}
        </View>
        <IconButton glyph="›" label="Later source day" onPress={() => setSourceDate((d) => addDays(d, 1))} />
      </View>

      <View accessible style={styles.preview}>
        {source.isLoading ? (
          <AppText muted>Loading...</AppText>
        ) : source.isError ? (
          <AppText style={{ color: colors.danger }}>Could not load that day.</AppText>
        ) : items.length === 0 ? (
          <AppText muted>Nothing to copy from this {group ? 'meal' : 'day'}.</AppText>
        ) : (
          <>
            <AppText style={{ fontWeight: '600' }}>
              {items.length} {items.length === 1 ? 'item' : 'items'}, {formatNumber(kcal)} kcal
            </AppText>
            {items.slice(0, 5).map((e) => (
              <AppText key={e.id} variant="small" muted numberOfLines={1}>
                {e.food.name}
              </AppText>
            ))}
            {items.length > 5 ? (
              <AppText variant="small" muted>
                and {items.length - 5} more
              </AppText>
            ) : null}
          </>
        )}
      </View>

      {sameDay ? (
        <AppText variant="small" muted>
          Pick a different day than the one you are copying into.
        </AppText>
      ) : null}
      {copy.isError ? (
        <AppText variant="small" style={{ color: colors.danger }}>
          Copy failed. Check your connection and try again.
        </AppText>
      ) : null}

      <Button
        label={items.length > 0 ? `Copy ${items.length} ${items.length === 1 ? 'item' : 'items'} to ${scopeLabel === 'day' ? formatDayLabel(targetDate) : scopeLabel}` : 'Copy'}
        onPress={doCopy}
        loading={copy.isPending}
        disabled={items.length === 0 || sameDay}
      />
    </>
  );
}

const styles = StyleSheet.create({
  stepper: { flexDirection: 'row', alignItems: 'center', borderRadius: radius.md, padding: spacing.xs },
  stepperDate: { flex: 1, alignItems: 'center' },
  preview: { gap: spacing.xs, minHeight: 60, justifyContent: 'center' },
});
