import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

export const SUGGESTED_PROMPTS: readonly string[] = [
  'How is my protein intake this week?',
  'Which micronutrients am I low on?',
  'Am I in a sustainable deficit?',
  'How much magnesium should I take before sleep?',
  'How was my last workout?',
  'How can I improve my sleep for recovery?',
];

/**
 * Empty-thread starter: the coach's scope in one line plus tappable example questions (`prompts` replaces the
 * defaults, e.g. for a chat about a workout). A tap sends the question; nothing is sent without a tap.
 */
export function SuggestedPrompts({
  onSelect,
  disabled = false,
  prompts = SUGGESTED_PROMPTS,
  title = 'Ask your coach',
}: {
  onSelect: (prompt: string) => void;
  disabled?: boolean;
  prompts?: readonly string[];
  title?: string;
}) {
  const { colors, radius } = useTheme();
  return (
    <View style={styles.root}>
      <View style={styles.intro}>
        <AppText variant="heading" accessibilityRole="header">
          {title}
        </AppText>
        <AppText muted>
          Food and macros, vitamins and supplements, training, recovery and sleep, body composition, and what your own
          logged data says. Your coach reads your recent diary, weight, workouts and sleep each time you ask.
        </AppText>
      </View>
      <View style={styles.list} accessibilityRole="list">
        {prompts.map((prompt) => (
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
                borderRadius: radius.lg,
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
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  chipText: { fontWeight: '600' },
});
