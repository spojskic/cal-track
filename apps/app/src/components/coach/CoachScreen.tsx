import { router, Stack, type Href } from 'expo-router';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { useAiBootstrap } from '@/ai/use-ai-bootstrap';
import { useAiClient } from '@/ai/use-ai-client';
import { useAiGate } from '@/ai/use-ai-gate';
import type { CoachTopic } from '@/ai/coach-topic';
import { useCoachChat } from '@/ai/use-coach-chat';
import { WIDE_BREAKPOINT, spacing, useTheme } from '@/theme';

import { ChatView } from './ChatView';
import { CoachUnavailable } from './CoachUnavailable';
import { ThreadList } from './ThreadList';

const COACH = '/coach' as unknown as Href;
const HISTORY = '/coach/history' as unknown as Href;
const threadHref = (id: string) => `/coach/${id}` as unknown as Href;

const SIDEBAR_WIDTH = 320;

function HeaderButton({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [styles.headerButton, { opacity: pressed ? 0.6 : 1 }]}>
      <Text style={[styles.headerButtonLabel, { color: colors.primary }]}>{label}</Text>
    </Pressable>
  );
}

/** Gate wrapper: the coach (and every data/AI hook behind it) mounts only when the AI gate is open. */
function useCoachAccess() {
  useAiBootstrap(); // deep links / web reloads reach this screen without the (app) shell mounted
  const gate = useAiGate();
  const handle = useAiClient();
  return { open: gate.enabled && handle !== null, reason: gate.reason };
}

/**
 * `/coach` and `/coach/[threadId]`. Wide screens show the history as a left column with the chat on the right;
 * phones show only the chat, with history one tap away as its own route. `/coach?topicKind=workout&topicId=...`
 * opens (or resumes) a conversation ABOUT that workout (`topic`).
 */
export function CoachScreen({
  initialThreadId = null,
  topic = null,
}: {
  initialThreadId?: string | null;
  topic?: CoachTopic | null;
}) {
  const access = useCoachAccess();
  if (!access.open) return <CoachUnavailable reason={access.reason} />;
  return <CoachWorkspace initialThreadId={initialThreadId} topic={topic} />;
}

function CoachWorkspace({ initialThreadId, topic = null }: { initialThreadId: string | null; topic?: CoachTopic | null }) {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_BREAKPOINT;
  const chat = useCoachChat({ initialThreadId, topic });

  // On phones the URL names the open thread (or the topic), so "new chat" leaves it by replacing the route.
  const startNew = () => {
    if (!wide && (initialThreadId || topic)) router.replace(COACH);
    else chat.newChat();
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Coach',
          // Wide screens have both in the left column (New chat button + the chat list itself).
          headerRight: wide
            ? undefined
            : () => (
                <View style={styles.headerActions}>
                  <HeaderButton label="New chat" onPress={startNew} />
                  <HeaderButton label="History" onPress={() => router.push(HISTORY)} />
                </View>
              ),
        }}
      />
      {wide ? (
        <View style={[styles.sidebar, { borderRightColor: colors.border, backgroundColor: colors.surfaceAlt }]}>
          <ThreadList
            selectedId={chat.threadId}
            onSelect={chat.openThread}
            onNewChat={chat.newChat}
            onDeleted={(id) => {
              if (id === chat.threadId) chat.newChat();
            }}
            onDeletedAll={chat.newChat}
          />
        </View>
      ) : null}
      <View style={styles.main}>
        <ChatView chat={chat} onStartNew={startNew} />
      </View>
    </View>
  );
}

/** `/coach/history`: the thread list as its own page on phones; on wide screens the full workspace. */
export function CoachHistoryScreen() {
  const access = useCoachAccess();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  if (!access.open) return <CoachUnavailable reason={access.reason} title="Chat history" />;
  if (width >= WIDE_BREAKPOINT) return <CoachWorkspace initialThreadId={null} />;
  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: true, title: 'Chat history' }} />
      <ThreadList
        onSelect={(id) => router.replace(threadHref(id))}
        onNewChat={() => router.replace(COACH)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row' },
  sidebar: { width: SIDEBAR_WIDTH, borderRightWidth: StyleSheet.hairlineWidth },
  main: { flex: 1 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  headerButton: { minHeight: 36, justifyContent: 'center', paddingHorizontal: spacing.xs },
  headerButtonLabel: { fontSize: 16, fontWeight: '600' },
});
