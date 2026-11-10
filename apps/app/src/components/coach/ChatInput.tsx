import { useCallback, useEffect, useState } from 'react';
import {
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputKeyPressEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MAX_MESSAGE_CHARS, type CoachPhase } from '@/ai/use-coach-chat';
import { AppText } from '@/components/ui';
import { radius, spacing, useTheme } from '@/theme';

export const COACH_DISCLAIMER = 'Not medical advice. For health concerns talk to a professional.';

const MIN_HEIGHT = 46;
const MAX_HEIGHT = 140;

function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setVisible(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

/**
 * Message box with Send / Stop and the permanent disclaimer. Enter sends on web (Shift+Enter inserts a line
 * break); on phones Enter adds a line break and the Send button sends. `onSend` returns whether the message was
 * accepted; the draft is only cleared then.
 */
export function ChatInput({
  onSend,
  onStop,
  phase,
  disabled = false,
  placeholder = 'Ask your coach...',
}: {
  onSend: (text: string) => boolean;
  onStop: () => void;
  phase: CoachPhase;
  /** Cannot type a new message (conversation still loading, thread missing...). */
  disabled?: boolean;
  placeholder?: string;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const [value, setValue] = useState('');
  const [height, setHeight] = useState(MIN_HEIGHT);

  const running = phase === 'preparing' || phase === 'streaming';
  const busy = phase !== 'idle';
  const canSend = !disabled && !busy && value.trim().length > 0;

  const submit = useCallback(() => {
    if (!canSend) return;
    if (onSend(value)) {
      setValue('');
      setHeight(MIN_HEIGHT);
    }
  }, [canSend, onSend, value]);

  const onKeyPress = (e: TextInputKeyPressEvent): void => {
    if (Platform.OS !== 'web') return;
    const ne = e.nativeEvent as unknown as { key: string; shiftKey?: boolean; isComposing?: boolean };
    if (ne.key === 'Enter' && !ne.shiftKey && !ne.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: colors.background,
          borderTopColor: colors.border,
          paddingBottom: keyboardVisible ? spacing.sm : Math.max(insets.bottom, spacing.sm),
        },
      ]}>
      <View style={styles.inner}>
        <View style={styles.row}>
          <TextInput
            value={value}
            onChangeText={setValue}
            onKeyPress={onKeyPress}
            onContentSizeChange={(e) =>
              // The box grows with the TEXT only (a placeholder that wraps must not make an empty box taller than the button),
              // and its own top/bottom padding is part of the height.
              setHeight(
                value.length === 0
                  ? MIN_HEIGHT
                  : Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(e.nativeEvent.contentSize.height) + spacing.md * 2)),
              )
            }
            placeholder={disabled ? 'Loading conversation...' : placeholder}
            placeholderTextColor={colors.textMuted}
            editable={!disabled}
            multiline
            maxLength={MAX_MESSAGE_CHARS}
            accessibilityLabel="Message your coach"
            accessibilityHint={Platform.OS === 'web' ? 'Press Enter to send, Shift and Enter for a new line' : undefined}
            style={[
              styles.input,
              {
                height,
                color: colors.text,
                backgroundColor: colors.surface,
                borderColor: colors.border,
              },
            ]}
          />
          {running ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Stop generating"
              onPress={onStop}
              style={({ pressed }) => [styles.action, { backgroundColor: colors.surfaceAlt, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth, opacity: pressed ? 0.7 : 1 }]}>
              <View style={[styles.stopGlyph, { backgroundColor: colors.text }]} />
              <Text style={[styles.actionLabel, { color: colors.text }]}>Stop</Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send message"
              accessibilityState={{ disabled: !canSend }}
              disabled={!canSend}
              onPress={submit}
              style={({ pressed }) => [
                styles.action,
                { backgroundColor: colors.primary, opacity: !canSend ? 0.45 : pressed ? 0.85 : 1 },
              ]}>
              <Text style={[styles.actionLabel, { color: colors.onPrimary }]}>{phase === 'finishing' ? 'Saving' : 'Send'}</Text>
            </Pressable>
          )}
        </View>
        <AppText variant="small" muted style={styles.disclaimer}>
          {COACH_DISCLAIMER}
        </AppText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  inner: { width: '100%', maxWidth: 760, alignSelf: 'center', gap: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  input: {
    flex: 1,
    minHeight: MIN_HEIGHT,
    maxHeight: MAX_HEIGHT,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    fontSize: 16,
    lineHeight: 21,
  },
  action: {
    minHeight: MIN_HEIGHT,
    minWidth: 72,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
  },
  actionLabel: { fontSize: 15, fontWeight: '700' },
  stopGlyph: { width: 10, height: 10, borderRadius: 2 },
  disclaimer: { textAlign: 'center' },
});
