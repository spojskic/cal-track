import { router, type Href } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { Notice } from '@/components/ai/AiBits';
import { IconButton } from '@/components/diary/IconButton';
import { ActionMenu, Sheet } from '@/components/diary/Sheet';
import { TextField } from '@/components/forms';
import { AppText, Button } from '@/components/ui';
import {
  NEW_CHAT_TITLE,
  useCoachThreads,
  useDeleteAllCoachChats,
  useDeleteCoachThread,
  useRenameCoachThread,
  type CoachThreadItem,
} from '@/data/coach';
import { useProfile } from '@/data/profile';
import { spacing, useTheme } from '@/theme';

import { previewOf, relativeTime } from './format';

const AI_SETTINGS = '/settings/ai' as unknown as Href;

/** Server-side retention default (app_settings.coach_retention_days). */
export const RETENTION_DAYS = 90;

function DangerButton({ label, onPress, loading }: { label: string; onPress: () => void; loading?: boolean }) {
  const { colors, radius } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      disabled={loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.danger,
        { backgroundColor: colors.danger, borderRadius: radius.pill, opacity: loading ? 0.5 : pressed ? 0.85 : 1 },
      ]}>
      {loading ? (
        <ActivityIndicator color={colors.onDanger} />
      ) : (
        <Text style={[styles.dangerLabel, { color: colors.onDanger }]}>{label}</Text>
      )}
    </Pressable>
  );
}

/**
 * Conversation history: title, last message preview and relative time per thread, an overflow menu
 * (rename / delete), "Delete all chats" with confirmation, and the retention info line.
 */
export function ThreadList({
  selectedId = null,
  onSelect,
  onNewChat,
  onDeleted,
  onDeletedAll,
}: {
  selectedId?: string | null;
  onSelect: (id: string) => void;
  onNewChat?: () => void;
  /** A thread was deleted (so a parent showing it can switch away). */
  onDeleted?: (id: string) => void;
  onDeletedAll?: () => void;
}) {
  const { colors } = useTheme();
  const threads = useCoachThreads();
  const profile = useProfile();
  const rename = useRenameCoachThread();
  const remove = useDeleteCoachThread();
  const removeAll = useDeleteAllCoachChats();

  const [menuFor, setMenuFor] = useState<CoachThreadItem | null>(null);
  const [renaming, setRenaming] = useState<CoachThreadItem | null>(null);
  const [renameText, setRenameText] = useState('');
  const [deleting, setDeleting] = useState<CoachThreadItem | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  const autoDelete = profile.data?.coach_auto_delete ?? true;
  const items = threads.data ?? [];

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <AppText variant="heading" accessibilityRole="header" style={styles.headerTitle}>
          Chats
        </AppText>
        {onNewChat ? <Button label="New chat" variant="secondary" onPress={onNewChat} /> : null}
      </View>

      {threads.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} accessibilityLabel="Loading chats" />
        </View>
      ) : threads.isError ? (
        <View style={styles.pad}>
          <Notice tone="danger" live>
            Could not load your chats. Check your connection and try again.
          </Notice>
          <Button label="Try again" variant="secondary" onPress={() => void threads.refetch()} />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(t) => t.id}
          style={styles.list}
          contentContainerStyle={items.length === 0 ? styles.emptyContent : undefined}
          ListEmptyComponent={
            <View style={styles.center}>
              <AppText muted style={styles.centerText}>
                No chats yet. Ask your coach something and the conversation will appear here.
              </AppText>
            </View>
          }
          renderItem={({ item }) => {
            const selected = item.id === selectedId;
            const title = item.title?.trim() || NEW_CHAT_TITLE;
            const time = relativeTime(item.lastActivityAt);
            const preview = item.lastMessage
              ? `${item.lastRole === 'user' ? 'You: ' : ''}${previewOf(item.lastMessage)}`
              : 'No messages';
            return (
              <View
                style={[
                  styles.row,
                  { borderBottomColor: colors.border },
                  selected && { backgroundColor: colors.surfaceAlt },
                ]}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${title}. ${time}. ${preview}`}
                  accessibilityState={{ selected }}
                  onPress={() => onSelect(item.id)}
                  style={({ pressed }) => [styles.rowMain, { opacity: pressed ? 0.7 : 1 }]}>
                  <View style={styles.rowTop}>
                    <AppText numberOfLines={1} style={styles.rowTitle}>
                      {title}
                    </AppText>
                    <AppText variant="small" muted>
                      {time}
                    </AppText>
                  </View>
                  <AppText variant="small" muted numberOfLines={2}>
                    {preview}
                  </AppText>
                </Pressable>
                <IconButton glyph={'\u22EF'} label={`Options for ${title}`} onPress={() => setMenuFor(item)} size={36} />
              </View>
            );
          }}
        />
      )}

      <View style={[styles.footer, { borderTopColor: colors.border }]}>
        <AppText variant="small" muted>
          {autoDelete
            ? `Chats are stored in your Ration account and deleted automatically after ${RETENTION_DAYS} days.`
            : 'Chats are stored in your Ration account until you delete them.'}{' '}
          Your OpenRouter key is never stored there.
        </AppText>
        <Pressable
          accessibilityRole="link"
          onPress={() => router.push(AI_SETTINGS)}
          hitSlop={6}>
          <AppText variant="small" style={{ color: colors.accent, fontWeight: '700' }}>
            Change in Settings &gt; AI
          </AppText>
        </Pressable>
        {items.length > 0 ? (
          <Pressable accessibilityRole="button" onPress={() => setConfirmAll(true)} style={styles.deleteAll}>
            <AppText variant="small" style={{ color: colors.danger, fontWeight: '700' }}>
              Delete all chats
            </AppText>
          </Pressable>
        ) : null}
      </View>

      <ActionMenu
        visible={menuFor !== null}
        title={menuFor?.title ?? NEW_CHAT_TITLE}
        onClose={() => setMenuFor(null)}
        actions={
          menuFor
            ? [
                {
                  key: 'rename',
                  label: 'Rename',
                  onPress: () => {
                    setRenameText(menuFor.title ?? '');
                    setRenaming(menuFor);
                  },
                },
                { key: 'delete', label: 'Delete', destructive: true, onPress: () => setDeleting(menuFor) },
              ]
            : []
        }
      />

      <Sheet visible={renaming !== null} onClose={() => setRenaming(null)} title="Rename chat">
        <TextField
          label="Title"
          value={renameText}
          onChangeText={setRenameText}
          maxLength={80}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={() => {
            if (renaming && renameText.trim()) {
              rename.mutate({ id: renaming.id, title: renameText });
              setRenaming(null);
            }
          }}
        />
        {rename.isError ? <Notice tone="danger" live>Could not rename the chat. Try again.</Notice> : null}
        <Button
          label="Save"
          disabled={!renameText.trim()}
          loading={rename.isPending}
          onPress={() => {
            if (!renaming) return;
            rename.mutate({ id: renaming.id, title: renameText });
            setRenaming(null);
          }}
        />
      </Sheet>

      <Sheet visible={deleting !== null} onClose={() => setDeleting(null)} title="Delete this chat?">
        <AppText muted>
          &quot;{deleting?.title?.trim() || NEW_CHAT_TITLE}&quot; and all its messages are permanently deleted. This
          cannot be undone.
        </AppText>
        {remove.isError ? <Notice tone="danger" live>Could not delete the chat. Try again.</Notice> : null}
        <DangerButton
          label="Delete chat"
          loading={remove.isPending}
          onPress={() => {
            if (!deleting) return;
            const id = deleting.id;
            remove.mutate(id, {
              onSuccess: () => {
                setDeleting(null);
                onDeleted?.(id);
              },
            });
          }}
        />
        <Button label="Cancel" variant="secondary" onPress={() => setDeleting(null)} />
      </Sheet>

      <Sheet visible={confirmAll} onClose={() => setConfirmAll(false)} title="Delete all chats?">
        <AppText muted>Every coach conversation in your account is permanently deleted. This cannot be undone.</AppText>
        {removeAll.isError ? <Notice tone="danger" live>Could not delete the chats. Check your connection and try again.</Notice> : null}
        <DangerButton
          label="Yes, delete all chats"
          loading={removeAll.isPending}
          onPress={() =>
            removeAll.mutate(undefined, {
              onSuccess: () => {
                setConfirmAll(false);
                onDeletedAll?.();
              },
            })
          }
        />
        <Button label="Cancel" variant="secondary" onPress={() => setConfirmAll(false)} />
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  headerTitle: { flexShrink: 1 },
  list: { flex: 1 },
  emptyContent: { flexGrow: 1 },
  pad: { padding: spacing.lg, gap: spacing.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  centerText: { textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingLeft: spacing.lg,
    paddingRight: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowMain: { flex: 1, minHeight: 64, justifyContent: 'center', gap: 2, paddingVertical: spacing.md },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: spacing.sm },
  rowTitle: { flex: 1, fontWeight: '700' },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  deleteAll: { minHeight: 36, justifyContent: 'center', alignSelf: 'flex-start', marginTop: spacing.xs },
  danger: {
    minHeight: 46,
    paddingHorizontal: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dangerLabel: { fontSize: 15, fontWeight: '700' },
});
