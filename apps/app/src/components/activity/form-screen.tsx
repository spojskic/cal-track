import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { AppText, Button } from '@/components/ui';
import { MAX_CONTENT_WIDTH, spacing, useTheme } from '@/theme';

import { formatDateLabel } from './format';

/** Keyboard-friendly, centred form page (phone + wide web). */
export function FormScreen({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets>
        <View style={styles.content}>{children}</View>
      </ScrollView>
    </View>
  );
}

/** "Logging to <date>" line shown at the top of every activity form. */
export function DateBanner({ date }: { date: string }) {
  return (
    <AppText variant="small" muted accessibilityLabel={`Logging to ${formatDateLabel(date)}`}>
      Logging to {formatDateLabel(date)}
    </AppText>
  );
}

export function FormError({ message }: { message?: string | null }) {
  const { colors } = useTheme();
  if (!message) return null;
  return (
    <AppText variant="small" accessibilityRole="alert" style={{ color: colors.danger }}>
      {message}
    </AppText>
  );
}

export function FormActions({
  saveLabel,
  onSave,
  onCancel,
  saving,
  disabled,
  cancelLabel = 'Cancel',
}: {
  saveLabel: string;
  onSave: () => void;
  onCancel: () => void;
  saving?: boolean;
  disabled?: boolean;
  cancelLabel?: string;
}) {
  return (
    <View style={styles.actions}>
      <Button label={saveLabel} onPress={onSave} loading={saving} disabled={disabled} />
      <Button label={cancelLabel} variant="ghost" onPress={onCancel} disabled={saving} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { flexGrow: 1 },
  content: {
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: 'center',
    padding: spacing.lg,
    gap: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  actions: { gap: spacing.sm },
});
