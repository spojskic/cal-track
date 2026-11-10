import { router, type Href } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Note } from '@/components/settings/rows';
import { AppText, Button } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

import type { DetailsReadState } from './use-workout-details-read';

const INTEGRATIONS = '/settings/integrations' as unknown as Href;

/** Shown while the details are being read from Garmin, and when they could not be: a clear sentence and what to do next. */
export function DetailsStatus({ state }: { state: DetailsReadState }) {
  const { colors } = useTheme();
  if (state.status === 'idle') return null;
  if (state.status === 'loading') {
    return (
      <View style={styles.loading} accessibilityRole="progressbar" accessibilityLabel="Reading the details from Garmin">
        <ActivityIndicator color={colors.primary} />
        <AppText muted>Reading the details from Garmin...</AppText>
      </View>
    );
  }
  const signIn = state.reason === 'needs_sign_in' || state.reason === 'not_connected';
  const retryable = state.reason !== 'rate_limited' && !signIn;
  return (
    <View style={styles.error}>
      <Note tone="warning">{state.message}</Note>
      {signIn ? <Button label="Open Connected apps" variant="secondary" onPress={() => router.push(INTEGRATIONS)} /> : null}
      {retryable ? <Button label="Try again" variant="secondary" onPress={state.retry} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  error: { gap: spacing.md },
});
