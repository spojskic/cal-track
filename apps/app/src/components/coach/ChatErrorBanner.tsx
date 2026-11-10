import { router, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { CoachChatError } from '@/ai/use-coach-chat';
import { Notice } from '@/components/ai/AiBits';
import { AppText } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

import { OPENROUTER_CREDITS_URL, openUrl } from './links';

const AI_SETTINGS = '/settings/ai' as unknown as Href;

function BannerButton({
  label,
  onPress,
  primary = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  const { colors, radius } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: primary ? colors.primary : 'transparent',
          borderColor: primary ? colors.primary : colors.border,
          borderRadius: radius.pill,
          opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
        },
      ]}>
      <Text style={[styles.buttonLabel, { color: primary ? colors.onPrimary : colors.text }]}>{label}</Text>
    </Pressable>
  );
}

/** Seconds left until `at` (epoch ms), ticking once per second while it is in the future. */
function useCountdown(at: number | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!at) return undefined;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [at]);
  return at ? Math.max(0, Math.ceil((at - now) / 1000)) : null;
}

/**
 * Error callout above the input with the right next step for each failure: credits -> openrouter.ai/credits,
 * rejected key / unsuitable model -> Settings > AI, rate limit -> automatic retry countdown, offline / network
 * / save problems -> retry.
 */
export function ChatErrorBanner({
  error,
  online,
  onRetry,
  onDismiss,
}: {
  error: CoachChatError;
  online: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const seconds = useCountdown(error.autoRetryAt);
  const tone = error.kind === 'offline' || error.kind === 'rate_limit' ? 'warning' : 'danger';

  return (
    <Notice tone={tone} live>
      <View style={styles.body}>
        <AppText variant="small" style={styles.message}>
          {error.message}
        </AppText>
        {error.hint ? (
          <AppText variant="small" muted>
            {error.hint}
          </AppText>
        ) : null}
        {error.kind === 'rate_limit' && seconds !== null ? (
          <AppText variant="small" muted>
            {seconds > 0 ? `Trying again automatically in ${seconds}s.` : 'Trying again now...'}
          </AppText>
        ) : null}
        <View style={styles.actions}>
          {error.kind === 'credits' ? (
            <BannerButton primary label="Add credits" onPress={() => void openUrl(OPENROUTER_CREDITS_URL)} />
          ) : null}
          {error.kind === 'auth' || error.kind === 'model' ? (
            <BannerButton
              primary={error.kind === 'auth'}
              label={error.kind === 'auth' ? 'Reconnect in Settings > AI' : 'Change model in Settings > AI'}
              onPress={() => router.push(AI_SETTINGS)}
            />
          ) : null}
          {error.retryable ? (
            <BannerButton
              primary={error.kind !== 'model'}
              label={error.kind === 'rate_limit' ? 'Retry now' : 'Try again'}
              disabled={!online && error.kind !== 'offline'}
              onPress={onRetry}
            />
          ) : null}
          <BannerButton label="Dismiss" onPress={onDismiss} />
        </View>
      </View>
    </Notice>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.sm },
  message: { fontWeight: '600' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  button: {
    minHeight: 40,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLabel: { fontSize: 14, fontWeight: '700' },
});
