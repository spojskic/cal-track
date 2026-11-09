import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/ui';
import { radius, spacing, useTheme } from '@/theme';

export const SUGGESTED_PROMPTS: readonly string[] = [
  'How is my protein intake this week?',
  'Am I in a sustainable deficit?',
  'Plan a 3-day push/pull/legs split',
  'What should I eat before a morning run?',
  'How can I improve my sleep for recovery?',
  "Review yesterday's food log",
];

/** Empty-thread starter: the coach's scope in one line plus six tappable example questions. */
export function SuggestedPrompts({
  onSelect,
  disabled = false,
}: {
  onSelect: (prompt: string) => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.root}>
      <View style={styles.intro}>
        <AppText variant="heading" accessibilityRole="header">
          Ask your coach
        </AppText>
        <AppText muted>
          Nutrition, training, recovery and sleep, body composition, and what your own logged data says. Your coach
          reads your recent diary, weight and activity each time you ask.
        </AppText>
      </View>
      <View style={styles.list} accessibilityRole="list">
        {SUGGESTED_PROMPTS.map((prompt) => (
          <Pressable
            key={prompt}
            accessibilityRole="button"
            accessibilityLabel={`Ask: ${prompt}`}
            disabled={disabled}
            onPress={() => onSelect(prompt)}
            style={({ pressed }) => [
              styles.chip,
              {
                backgroundColor: pressed ? colors.surfaceAlt : colors.surface,
                borderColor: colors.border,
                opacity: disabled ? 0.5 : 1,
              },
            ]}>
            <AppText style={styles.chipText}>{prompt}</AppText>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.lg, paddingVertical: spacing.lg },
  intro: { gap: spacing.xs },
  list: { gap: spacing.sm },
  chip: {
    minHeight: 48,
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  chipText: { fontWeight: '600' },
});
