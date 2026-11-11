import type { AiGateReason } from '@ration/ai';
import { router, Stack, type Href } from 'expo-router';
import { ActivityIndicator } from 'react-native';

import { useAiStore } from '@/ai/ai-store';
import { AppText, Button, Card, Screen } from '@/components/ui';

const AI_SETTINGS = '/settings/ai' as unknown as Href;

/**
 * Shown instead of the coach whenever the AI gate is closed (deep link, web reload, key removed). It makes no AI
 * call and loads no chat data.
 */
export function CoachUnavailable({ reason, title = 'Coach' }: { reason: AiGateReason | null; title?: string }) {
  const loaded = useAiStore((s) => s.loaded);
  const validating = useAiStore((s) => s.validating);
  const modelsBusy = useAiStore((s) => s.modelsBusy);
  const revalidate = useAiStore((s) => s.revalidate);

  const checking = !loaded || validating || ((reason === 'no_model' || reason === 'model_not_vision') && modelsBusy);
  // A key exists but could not be verified (offline or OpenRouter down): not the user's fault, offer a retry.
  const unverified = !checking && reason === 'checking';
  const rejected = reason === 'invalid_key';
  const needsModel = reason === 'no_model' || reason === 'model_not_vision';

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: true, title }} />
      <Card>
        {checking ? (
          <>
            <AppText variant="heading" accessibilityRole="header">
              Checking your AI connection...
            </AppText>
            <ActivityIndicator accessibilityLabel="Checking" />
          </>
        ) : unverified ? (
          <>
            <AppText variant="heading" accessibilityRole="header">
              Could not check your OpenRouter key
            </AppText>
            <AppText muted>
              Check your internet connection and try again. Your coach needs a working OpenRouter key.
            </AppText>
            <Button label="Try again" onPress={() => void revalidate()} />
          </>
        ) : (
          <>
            <AppText variant="heading" accessibilityRole="header">
              {rejected
                ? 'Your OpenRouter key was rejected'
                : needsModel
                  ? 'Choose a model for the coach'
                  : 'The coach needs OpenRouter'}
            </AppText>
            <AppText muted>
              {rejected
                ? 'Reconnect OpenRouter in Settings > AI to use the coach.'
                : needsModel
                  ? 'Pick a model in Settings > AI to use the coach.'
                  : 'Connect OpenRouter in Settings > AI to use the coach. It is optional and uses your own key; nothing is sent until you connect.'}
            </AppText>
          </>
        )}
        <Button
          label="Open Settings > AI"
          variant={unverified ? 'secondary' : 'primary'}
          onPress={() => router.push(AI_SETTINGS)}
        />
      </Card>
    </Screen>
  );
}
