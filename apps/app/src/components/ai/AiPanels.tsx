import type { AiErrorPresentation } from '@cal/ai';
import { router, type Href } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { AppText, Button, Card } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

import { Notice } from './AiBits';

const AI_SETTINGS = '/settings/ai' as unknown as Href;

export function openAiSettings(): void {
  router.push(AI_SETTINGS);
}

/** Friendly failure card: the message, a "Try another model" hint when the failure looks model specific. */
export function AiErrorPanel({
  error,
  onRetry,
  retryLabel = 'Try again',
  secondary,
}: {
  error: AiErrorPresentation;
  onRetry?: () => void;
  retryLabel?: string;
  /** Extra action, e.g. "Choose another photo". */
  secondary?: { label: string; onPress: () => void };
}) {
  return (
    <Card>
      <Notice tone="danger" live>
        {error.message}
      </Notice>
      {error.hint ? <AppText variant="small" muted>{error.hint}</AppText> : null}
      <View style={styles.actions}>
        {onRetry ? <Button label={retryLabel} onPress={onRetry} /> : null}
        {secondary ? <Button label={secondary.label} variant="secondary" onPress={secondary.onPress} /> : null}
        {error.tryAnotherModel || error.needsReconnect ? (
          <Button
            label={error.needsReconnect ? 'Reconnect OpenRouter' : 'Try another model'}
            variant="secondary"
            onPress={openAiSettings}
          />
        ) : null}
      </View>
    </Card>
  );
}

/** Progress state with a live-region label and a cancel button. */
export function AiWorking({ label, onCancel }: { label: string; onCancel?: () => void }) {
  const { colors } = useTheme();
  return (
    <Card>
      <View style={styles.working} accessibilityLiveRegion="polite">
        <ActivityIndicator color={colors.primary} size="large" accessibilityLabel="Working" />
        <AppText variant="body" style={styles.center}>{label}</AppText>
        <AppText variant="small" muted style={styles.center}>
          This usually takes 5 to 20 seconds.
        </AppText>
      </View>
      {onCancel ? <Button label="Cancel" variant="ghost" onPress={onCancel} /> : null}
    </Card>
  );
}

/** Shown when a deep link opens an AI screen while the AI gate is closed. */
export function AiNotAvailable({ reason }: { reason: string | null }) {
  const checking = reason === 'checking';
  return (
    <Card>
      <AppText variant="heading">{checking ? 'Checking your AI connection...' : 'AI is not set up'}</AppText>
      {checking ? (
        <ActivityIndicator accessibilityLabel="Checking" />
      ) : (
        <AppText muted>
          {reason === 'invalid_key'
            ? 'Your OpenRouter key was rejected. Reconnect it in Settings.'
            : 'AI features are optional. Connect your own OpenRouter key in Settings to use them.'}
        </AppText>
      )}
      <Button label="Open AI settings" variant="secondary" onPress={openAiSettings} />
    </Card>
  );
}

const styles = StyleSheet.create({
  actions: { gap: spacing.sm },
  working: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.lg },
  center: { textAlign: 'center' },
});
