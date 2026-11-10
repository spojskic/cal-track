// Web (and the fallback for TypeScript): Garmin's sign-in page cannot be shown here, and Garmin cannot be read from a browser
// anyway (CORS). Metro uses GarminSignInView.native.tsx on iOS and Android, which holds the web view.
import { View } from 'react-native';

import { Note } from '@/components/settings/rows';
import { AppText, Button } from '@/components/ui';
import { GARMIN_WEB_NOTE } from '@/health/garmin';
import { spacing } from '@/theme';

import type { GarminSignInViewProps } from './garmin-signin-types';

export function GarminSignInView({ onDone }: GarminSignInViewProps) {
  return (
    <View style={{ padding: spacing.lg, gap: spacing.lg }}>
      <AppText variant="heading">Sign in to Garmin</AppText>
      <Note>{GARMIN_WEB_NOTE}</Note>
      <Button label="Back to Connected Apps" variant="secondary" onPress={onDone} />
    </View>
  );
}
