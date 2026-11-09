import { StyleSheet, Text, View } from 'react-native';

import { radius, spacing, useTheme } from '@/theme';

/** Brief confirmation / error message pinned to the bottom of its parent. Render it conditionally. */
export function Toast({ message, tone = 'success' }: { message: string; tone?: 'success' | 'error' }) {
  const { colors } = useTheme();
  return (
    <View pointerEvents="none" style={styles.wrap}>
      <View
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        style={[styles.toast, { backgroundColor: tone === 'success' ? colors.accent : colors.danger }]}>
        <Text style={[styles.text, { color: colors.onPrimary }]} numberOfLines={3}>
          {message}
        </Text>
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
  },
  toast: {
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    maxWidth: 560,
  },
  text: { fontSize: 14, fontWeight: '600', textAlign: 'center' },
});
