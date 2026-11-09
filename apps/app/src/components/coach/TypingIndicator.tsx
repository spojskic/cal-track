import { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/ui';
import { radius, spacing, useTheme } from '@/theme';

/** Three pulsing dots while the coach is preparing an answer. Static when the user prefers reduced motion. */
export function TypingIndicator({ label = 'Coach is thinking' }: { label?: string }) {
  const { colors } = useTheme();
  const [reduceMotion, setReduceMotion] = useState(false);
  const [values] = useState(() => [new Animated.Value(0.35), new Animated.Value(0.35), new Animated.Value(0.35)]);

  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => {
        if (!cancelled) setReduceMotion(v);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (reduceMotion) return undefined;
    const loops = values.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 160),
          Animated.timing(v, { toValue: 1, duration: 360, easing: Easing.inOut(Easing.quad), useNativeDriver: Platform.OS !== 'web' }),
          Animated.timing(v, { toValue: 0.35, duration: 360, easing: Easing.inOut(Easing.quad), useNativeDriver: Platform.OS !== 'web' }),
          Animated.delay((2 - i) * 160),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [reduceMotion, values]);

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
      style={styles.row}>
      <View style={[styles.bubble, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        {values.map((v, i) => (
          <Animated.View
            key={i}
            style={[styles.dot, { backgroundColor: colors.textMuted, opacity: reduceMotion ? 0.7 : v }]}
          />
        ))}
      </View>
      <AppText variant="small" muted>
        {label}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, alignSelf: 'flex-start' },
  bubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md + 2,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomLeftRadius: spacing.xs,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
