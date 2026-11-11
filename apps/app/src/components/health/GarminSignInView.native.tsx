// Garmin's own sign-in page in a web view. Ration never sees the password. When the page redirects to garmin.com with a
// single-use ticket, the app STOPS that navigation (so Garmin Connect does not spend the ticket), trades the ticket once for the
// token pair, keeps the pair in this phone's secure storage and goes back. Same flow as the reference app.
import { createTicketGate, isGarminError, SIGN_IN_URL } from '@cal/garmin';
import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { AppText, Button } from '@/components/ui';
import { switchToDeviceEnergyMode } from '@/data/energy-mode-notice';
import { completeGarminSignIn } from '@/health/garmin-actions';
import { errorText } from '@/health/sync';
import { spacing, useTheme } from '@/theme';

import type { GarminSignInViewProps } from './garmin-signin-types';

type Step = 'page' | 'redeeming' | 'failed';

function Message({ busy, text, children }: { busy: boolean; text: string; children?: React.ReactNode }) {
  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.lg }}>
      {busy ? <ActivityIndicator accessibilityLabel={text} /> : null}
      <AppText variant="body" style={{ textAlign: 'center' }} accessibilityLiveRegion="polite">{text}</AppText>
      {children}
    </View>
  );
}

export function GarminSignInView({ onDone }: GarminSignInViewProps) {
  const { colors } = useTheme();
  const [step, setStep] = useState<Step>('page');
  const [problem, setProblem] = useState('');
  // Remounts the web view on "Try again" (a spent ticket means signing in on Garmin's page again).
  const [attempt, setAttempt] = useState(0);
  // The ticket works once: only the first navigation that carries one is used.
  const [gate] = useState(createTicketGate);

  const fail = (text: string) => {
    gate.reset();
    setProblem(text);
    setStep('failed');
  };

  const redeem = async (ticket: string) => {
    setStep('redeeming');
    try {
      await completeGarminSignIn(ticket);
      void switchToDeviceEnergyMode();
    } catch (e) {
      fail(`Sign-in did not work. ${isGarminError(e) ? e.userMessage : errorText(e)}`);
      return;
    }
    onDone();
  };

  if (step === 'redeeming') return <Message busy text="Signing in..." />;
  if (step === 'failed') {
    return (
      <Message busy={false} text={problem}>
        <Button
          label="Try again"
          onPress={() => {
            setAttempt((n) => n + 1);
            setStep('page');
          }}
        />
        <Button label="Cancel" variant="ghost" onPress={onDone} />
      </Message>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <WebView
        key={attempt}
        source={{ uri: SIGN_IN_URL }}
        // Nothing of the Garmin web session is kept in the phone's browser storage after this screen: the next sign-in asks for
        // the password again (also when another Garmin account is wanted).
        incognito
        startInLoadingState
        renderLoading={() => <Message busy text="Loading Garmin's sign-in page..." />}
        onError={() => fail("Garmin's sign-in page could not be loaded. Check your internet connection.")}
        onShouldStartLoadWithRequest={(request) => {
          const { allow, ticket } = gate.inspect(request.url);
          if (ticket !== null) void redeem(ticket);
          return allow;
        }}
      />
    </View>
  );
}
