import { Pressable, StyleSheet, View } from 'react-native';

import { AppText, Button } from '@/components/ui';
import { radius, useTheme } from '@/theme';

import { Sheet } from './Sheet';

/**
 * Small confirm dialog for a bulk action: a title, an explanation, "Keep"/"Cancel" and the confirm button.
 * `destructive` paints the confirm button red (delete). The confirm button's accessible name is `confirmLabel`.
 */
export function ConfirmSheet({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onClose,
}: {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      <AppText accessibilityLiveRegion="polite">{message}</AppText>
      <View style={styles.buttons}>
        <View style={styles.flex}>
          <Button label={cancelLabel} variant="secondary" onPress={onClose} />
        </View>
        {destructive ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={confirmLabel}
            onPress={() => {
              onClose();
              onConfirm();
            }}
            style={[styles.confirm, { backgroundColor: colors.danger }]}>
            <AppText style={{ color: colors.onPrimary, fontWeight: '700', fontSize: 15 }}>{confirmLabel}</AppText>
          </Pressable>
        ) : (
          <View style={styles.flex}>
            <Button
              label={confirmLabel}
              onPress={() => {
                onClose();
                onConfirm();
              }}
            />
          </View>
        )}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  buttons: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  flex: { flex: 1 },
  confirm: { flex: 1, minHeight: 46, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
});
