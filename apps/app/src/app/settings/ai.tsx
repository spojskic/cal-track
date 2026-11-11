import { router, Stack, type Href } from 'expo-router';
import { looksLikeOAuthReturn } from '@ration/ai';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { useAiStore } from '@/ai/ai-store';
import { useAiBootstrap } from '@/ai/use-ai-bootstrap';
import { ModelPicker } from '@/components/ai/ModelPicker';
import {
  CoachRetentionCard,
  ConnectCard,
  ConnectionStatusCard,
  PrivacyCard,
} from '@/components/ai/settings-cards';
import { Screen } from '@/components/ui';

const SELF = '/settings/ai' as unknown as Href;

/**
 * Settings > AI. Always reachable (it is where the user connects). Sections that need a working key
 * (model picker, coach chat retention) appear only when connected and the key was validated.
 */
export default function AiSettingsScreen() {
  useAiBootstrap();
  const connected = useAiStore((s) => s.apiKey !== null && s.keyStatus === 'valid');

  // Web OAuth: OpenRouter redirects back to this page with ?code=...; finish the exchange, then clean the URL.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const url = window.location.href;
    if (!looksLikeOAuthReturn(url)) return;
    void useAiStore
      .getState()
      .finishOAuth({ kind: 'url', url })
      .finally(() => router.replace(SELF));
  }, []);

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: true, title: 'AI (optional)' }} />
      <ConnectionStatusCard />
      <ConnectCard />
      {connected ? <ModelPicker /> : null}
      {connected ? <CoachRetentionCard /> : null}
      <PrivacyCard />
    </Screen>
  );
}
