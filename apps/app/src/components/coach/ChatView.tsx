import { useHeaderHeight } from 'expo-router/react-navigation';
import { useCallback, useMemo, useRef, type ReactElement } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import type { CoachChat, CoachChatMessage } from '@/ai/use-coach-chat';
import { Notice } from '@/components/ai/AiBits';
import { AppText, Button, Card } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

import { ChatErrorBanner } from './ChatErrorBanner';
import { ChatInput } from './ChatInput';
import { AssistantContent, MessageBubble } from './MessageBubble';
import { SuggestedPrompts } from './SuggestedPrompts';
import { TypingIndicator } from './TypingIndicator';

const COLUMN_WIDTH = 760;

type Row =
  | { key: string; kind: 'message'; message: CoachChatMessage }
  | { key: string; kind: 'typing' }
  | { key: string; kind: 'stream'; text: string; partial: boolean };

/** Height of the navigation header, for the keyboard offset. 0 on web and where no header context exists. */
function useHeaderOffset(): number {
  if (Platform.OS === 'web') return 0;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- useHeaderHeight only reads a context; the try guards "no header"
    return useHeaderHeight();
  } catch {
    return 0;
  }
}

/** The conversation: messages, streaming reply, errors, suggested prompts and the input. */
export function ChatView({ chat, onStartNew }: { chat: CoachChat; onStartNew: () => void }) {
  const { colors } = useTheme();
  const headerOffset = useHeaderOffset();
  const listRef = useRef<FlatList<Row>>(null);
  const stickToBottom = useRef(true);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = chat.messages.map((message) => ({ key: message.id, kind: 'message', message }));
    if (chat.pendingReply) {
      out.push({ key: 'stream', kind: 'stream', text: chat.pendingReply, partial: chat.phase === 'streaming' });
    } else if (chat.phase === 'preparing') {
      out.push({ key: 'typing', kind: 'typing' });
    }
    return out;
  }, [chat.messages, chat.pendingReply, chat.phase]);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    stickToBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 140;
  }, []);

  const send = useCallback(
    (text: string): boolean => {
      stickToBottom.current = true;
      return chat.send(text);
    },
    [chat],
  );

  const inputDisabled = !chat.ready || chat.threadMissing || chat.loadFailed;

  let empty: ReactElement | null = null;
  if (chat.loading) {
    empty = (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} accessibilityLabel="Loading conversation" />
      </View>
    );
  } else if (chat.threadMissing) {
    empty = (
      <Card>
        <AppText variant="heading" accessibilityRole="header">
          This chat is no longer available
        </AppText>
        <AppText muted>It may have been deleted or removed by the automatic cleanup.</AppText>
        <Button label="Start a new chat" onPress={onStartNew} />
      </Card>
    );
  } else if (chat.loadFailed) {
    empty = (
      <View style={styles.gap}>
        <Notice tone="danger" live>
          Could not load this conversation. Check your connection and try again.
        </Notice>
        <Button label="Try again" variant="secondary" onPress={chat.reload} />
      </View>
    );
  } else if (chat.messages.length === 0 && !chat.busy) {
    empty = <SuggestedPrompts onSelect={(p) => void send(p)} disabled={!chat.ready} />;
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'web' ? undefined : 'padding'}
      keyboardVerticalOffset={headerOffset}>
      {!chat.online ? (
        <View style={styles.offline}>
          <Notice tone="warning" live>
            You are offline. Your coach needs an internet connection; you can keep reading this chat.
          </Notice>
        </View>
      ) : null}
      <FlatList
        ref={listRef}
        data={rows}
        keyExtractor={(r) => r.key}
        style={styles.flex}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        accessibilityLabel="Conversation with your coach"
        onScroll={onScroll}
        scrollEventThrottle={64}
        onContentSizeChange={() => {
          if (stickToBottom.current) listRef.current?.scrollToEnd({ animated: chat.phase === 'idle' });
        }}
        ListEmptyComponent={empty ?? undefined}
        renderItem={({ item }) => {
          if (item.kind === 'typing') return <TypingIndicator />;
          if (item.kind === 'stream') {
            return (
              <View style={styles.streamRow}>
                <AssistantContent text={item.text} partial={item.partial} />
              </View>
            );
          }
          return (
            <MessageBubble
              message={item.message}
              failed={item.message.id === chat.failedMessageId}
              stopped={chat.stopped}
              onRetry={chat.retry}
            />
          );
        }}
      />
      <View style={styles.footer}>
        {chat.error ? (
          <View style={styles.errorWrap}>
            <ChatErrorBanner error={chat.error} online={chat.online} onRetry={chat.retry} onDismiss={chat.dismissError} />
          </View>
        ) : null}
        <ChatInput onSend={send} onStop={chat.stop} phase={chat.phase} disabled={inputDisabled} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: {
    width: '100%',
    maxWidth: COLUMN_WIDTH,
    alignSelf: 'center',
    flexGrow: 1,
    padding: spacing.lg,
    gap: spacing.md,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  gap: { gap: spacing.md },
  offline: { width: '100%', maxWidth: COLUMN_WIDTH, alignSelf: 'center', paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  streamRow: { alignSelf: 'stretch', alignItems: 'flex-start' },
  footer: { width: '100%' },
  errorWrap: { width: '100%', maxWidth: COLUMN_WIDTH, alignSelf: 'center', paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
});
