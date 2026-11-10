import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { CoachChatMessage } from '@/ai/use-coach-chat';
import { AppText } from '@/components/ui';
import { detectRefusal } from '@/data/coach';
import { spacing, useTheme } from '@/theme';

import { Markdown } from './Markdown';
import { RefusalCard } from './RefusalCard';

/** What the coach said, as a refusal card when it is one of the fixed safety texts, else as a markdown bubble. */
export function AssistantContent({ text, partial = false }: { text: string; partial?: boolean }) {
  const { colors, radius, shape } = useTheme();
  const refusal = detectRefusal(text);
  if (refusal) return <RefusalCard text={text} category={refusal} />;
  return (
    <View style={styles.assistantWrap}>
      <AppText variant="label" muted style={styles.caption}>
        Coach
      </AppText>
      <View
        style={[
          styles.bubble,
          styles.assistantBubble,
          // the pointed corner is written inline with the other three (see tailedRadii)
          shape.tailed(radius.lg, spacing.xs, 'bottomLeft'),
          { backgroundColor: colors.surface, borderColor: colors.border },
        ]}>
        <Markdown text={text} partial={partial} />
      </View>
    </View>
  );
}

/**
 * One chat message. User messages sit on the right, replies on the left, refusals as a distinct notice card.
 * `failed` marks the last user message that has no answer, with a retry affordance.
 */
export function MessageBubble({
  message,
  failed = false,
  stopped = false,
  onRetry,
}: {
  message: CoachChatMessage;
  failed?: boolean;
  stopped?: boolean;
  onRetry?: () => void;
}) {
  const { colors, radius, shape } = useTheme();

  if (message.role === 'assistant') {
    return (
      <View style={styles.rowLeft}>
        <AssistantContent text={message.content} />
        {message.local ? (
          <AppText variant="small" style={{ color: colors.warning }}>
            Not saved to your history yet
          </AppText>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.rowRight}>
      <View
        style={[
          styles.bubble,
          styles.userBubble,
          shape.tailed(radius.lg, spacing.xs, 'bottomRight'),
          { backgroundColor: colors.primary },
        ]}>
        {/* What the user typed is shown literally (no markdown), so nothing they wrote gets reformatted. */}
        <Text selectable style={[styles.userText, { color: colors.onPrimary }]}>
          {message.content}
        </Text>
      </View>
      {failed ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={stopped ? 'Stopped. Retry this message' : 'Failed. Retry this message'}
          onPress={onRetry}
          hitSlop={8}
          style={({ pressed }) => [styles.failed, pressed && { opacity: 0.6 }]}>
          <AppText variant="small" style={{ color: colors.danger, fontWeight: '700' }}>
            {stopped ? 'Stopped' : 'Failed'} - retry
          </AppText>
        </Pressable>
      ) : message.local ? (
        <AppText variant="small" muted>
          Sending...
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  rowLeft: { alignItems: 'flex-start', gap: spacing.xs, alignSelf: 'stretch' },
  rowRight: { alignItems: 'flex-end', gap: spacing.xs, alignSelf: 'stretch' },
  assistantWrap: { maxWidth: '92%', gap: 2, alignItems: 'flex-start' },
  caption: { marginLeft: spacing.sm },
  bubble: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  userBubble: { maxWidth: '85%' },
  userText: { fontSize: 16, lineHeight: 23 },
  assistantBubble: { borderWidth: StyleSheet.hairlineWidth },
  failed: { minHeight: 28, justifyContent: 'center' },
});
