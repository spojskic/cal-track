import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/ui';
import { dismissDiaryToast, useDiaryToast } from '@/state/diary-toast';
import { spacing, useTheme } from '@/theme';

/**
 * Renders the diary toast pinned to the bottom of its parent: a message and an optional action button ("Undo").
 * The container is a polite live region so screen readers announce it; the wrapper lets touches through everywhere
 * except on the toast itself.
 */
export function ToastHost() {
  const { colors, radius } = useTheme();
  const toast = useDiaryToast((s) => s.toast);
  if (!toast) return null;
  const { action } = toast;

  return (
    <View style={styles.wrap}>
      <View
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        style={[
          styles.toast,
          { backgroundColor: toast.tone === 'success' ? colors.accent : colors.danger, borderRadius: radius.md },
        ]}>
        <AppText style={[styles.text, { color: colors.onPrimary }]} numberOfLines={3}>
          {toast.message}
        </AppText>
        {action ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={action.label}
            hitSlop={8}
            onPress={() => {
              dismissDiaryToast(toast.id);
              action.onPress();
            }}
            style={({ pressed }) => [
              styles.action,
              { borderColor: colors.onPrimary, borderRadius: radius.pill, opacity: pressed ? 0.7 : 1 },
            ]}>
            <AppText style={[styles.actionText, { color: colors.onPrimary }]}>{action.label}</AppText>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.xl,
    alignItems: 'center',
    // Touches pass through the empty part of the strip; only the toast itself is tappable.
    pointerEvents: 'box-none',
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingLeft: spacing.lg,
    paddingRight: spacing.md,
    paddingVertical: spacing.sm,
    maxWidth: 560,
  },
  text: { flexShrink: 1, fontSize: 14, fontWeight: '600' },
  action: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderWidth: 1,
  },
  actionText: { fontSize: 14, fontWeight: '800' },
});
