import type { LabelFoodDraft } from '@ration/core';
import { StyleSheet, View } from 'react-native';

import { AppText, Card } from '@/components/ui';
import { markedValueCount } from '@/state/label-draft';
import { spacing, useTheme } from '@/theme';

import { Notice } from './AiBits';
import { AiLabelButton } from './AiEntryPoints';

export const LABEL_BANNER_TEXT = 'Read from a photo of the label. Check every value before saving.';

/**
 * Top of the New food form after "Scan nutrition label": says where the numbers come from, lists the AI's own notes
 * and what the app converted or assumed, and offers a new scan. The form below carries the "?" markers.
 */
export function LabelDraftBanner({ draft, gtin, mealGroupId }: { draft: LabelFoodDraft; gtin?: string; mealGroupId?: string }) {
  const { colors } = useTheme();
  const marked = markedValueCount(draft);
  return (
    <Card style={{ borderColor: colors.warning }}>
      <AppText accessibilityRole="header" style={styles.title}>{LABEL_BANNER_TEXT}</AppText>
      {marked > 0 ? (
        <AppText variant="small" muted>
          {marked === 1
            ? 'One value is marked with ? because it was hard to read or does not add up. The mark goes away when you edit it.'
            : `${marked} values are marked with ? because they were hard to read or do not add up. A mark goes away when you edit that value.`}
        </AppText>
      ) : null}
      {draft.notes.length > 0 ? (
        <View style={styles.notes}>
          {draft.notes.map((note) => (
            <Notice key={note} tone="warning">
              {note}
            </Notice>
          ))}
        </View>
      ) : null}
      <AiLabelButton label="Scan a different label" variant="ghost" fromForm gtin={gtin} mealGroupId={mealGroupId} />
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 16, fontWeight: '700' },
  notes: { gap: spacing.sm },
});
