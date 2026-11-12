import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

import { TextField } from '@/components/forms';
import { AppText, Button, Card, Screen } from '@/components/ui';
import { createAccount } from '@/data/signup';
import { useAuth } from '@/lib/auth';
import {
  formatInviteCodeInput,
  hasErrors,
  validateSignUp,
  type SignUpField,
  type SignUpFieldErrors,
} from '@/lib/signup';
import { spacing, useTheme } from '@/theme';

type Mode = 'sign-in' | 'sign-up';

/** The invite e-mail links here with the code and the e-mail, so the Create account form starts half filled. */
function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

/**
 * Sign in, or create an account with an invite code (the owner generates codes in the Supabase SQL editor, see
 * docs/getting-started.md). Creating an account calls the Edge Function `sign-up`, then signs in with the same credentials:
 * the root layout's redirects take over from there (onboarding on first run).
 */
export default function SignInScreen() {
  const { signIn } = useAuth();
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ code?: string | string[]; email?: string | string[] }>();
  // The invite e-mail's link (?code=...&email=...) pre-fills the Create account form. What the user typed wins:
  // typed values are stored as soon as they edit, and the link values only fill the fields still untouched
  // (they keep applying while the router is still resolving the URL, which can happen after the first render).
  const [typedEmail, setTypedEmail] = useState<string | null>(null);
  const [typedCode, setTypedCode] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<SignUpFieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Mode>('sign-in');
  const email = typedEmail ?? firstParam(params.email);
  const inviteCode = typedCode ?? formatInviteCodeInput(firstParam(params.code));

  const signingUp = mode === 'sign-up';

  /** Edits a field and clears the error that was shown for it. */
  function edit(field: SignUpField, set: (value: string) => void) {
    return (value: string) => {
      set(value);
      setFieldErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
      setError(null);
    };
  }

  function resetSecrets() {
    setPassword('');
    setConfirmPassword('');
    setTypedCode('');
  }

  function switchMode() {
    if (busy) return;
    setMode(signingUp ? 'sign-in' : 'sign-up');
    // The e-mail address carries over; everything else starts empty and no old error stays on screen. The
    // invite code only clears when the user had typed it: a code that came from the invite link stays, it is
    // what they came with.
    setPassword('');
    setConfirmPassword('');
    if (typedCode !== null) setTypedCode('');
    setFieldErrors({});
    setError(null);
  }

  async function submitSignIn() {
    setBusy(true);
    setError(null);
    const message = await signIn(email, password);
    setBusy(false);
    if (message) setError(message);
  }

  async function submitSignUp() {
    const problems = validateSignUp({ email, password, confirmPassword, inviteCode });
    setFieldErrors(problems);
    setError(null);
    if (hasErrors(problems)) return;

    setBusy(true);
    const created = await createAccount({ email, password, inviteCode });
    if (!created.ok) {
      setBusy(false);
      if (created.field) setFieldErrors({ [created.field]: created.message });
      else setError(created.message);
      return;
    }
    // The account exists: sign in with the same credentials. On success the root layout redirects away from this screen.
    const message = await signIn(email, password);
    setBusy(false);
    if (message) {
      setMode('sign-in');
      resetSecrets();
      setError(`Your account was created, but signing in failed (${message}). Try signing in.`);
    }
  }

  function submit() {
    if (busy) return;
    void (signingUp ? submitSignUp() : submitSignIn());
  }

  const ready = signingUp
    ? Boolean(email && password && confirmPassword && inviteCode)
    : Boolean(email && password);

  return (
    <Screen title="Ration" safeTop>
      <Card>
        <AppText variant="heading">{signingUp ? 'Create account' : 'Sign in'}</AppText>
        <AppText muted variant="small">
          {signingUp
            ? 'You need an invite code from the app owner to create an account.'
            : 'New here? Ask the app owner for an invite code, then choose Create account.'}
        </AppText>
        <View style={styles.form}>
          {signingUp ? (
            <>
              <TextField
                label="Email"
                value={email}
                onChangeText={edit('email', setTypedEmail)}
                placeholder="you@example.com"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                textContentType="emailAddress"
                keyboardType="email-address"
                error={fieldErrors.email}
              />
              <TextField
                label="Password"
                value={password}
                onChangeText={edit('password', setPassword)}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="new-password"
                textContentType="newPassword"
                hint="At least 8 characters."
                error={fieldErrors.password}
              />
              <TextField
                label="Confirm password"
                value={confirmPassword}
                onChangeText={edit('confirmPassword', setConfirmPassword)}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="new-password"
                textContentType="newPassword"
                error={fieldErrors.confirmPassword}
              />
              <TextField
                label="Invite code"
                value={inviteCode}
                onChangeText={edit('inviteCode', (text) => setTypedCode(formatInviteCodeInput(text)))}
                placeholder="XXXX-XXXX-XXXX"
                autoCapitalize="characters"
                autoCorrect={false}
                spellCheck={false}
                autoComplete="off"
                returnKeyType="go"
                onSubmitEditing={submit}
                hint="Paste it or type it; dashes and spaces are optional."
                error={fieldErrors.inviteCode}
              />
            </>
          ) : (
            <>
              <TextField
                label="Email"
                value={email}
                onChangeText={edit('email', setTypedEmail)}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                textContentType="username"
                keyboardType="email-address"
              />
              <TextField
                label="Password"
                value={password}
                onChangeText={edit('password', setPassword)}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="current-password"
                textContentType="password"
                returnKeyType="go"
                onSubmitEditing={submit}
              />
            </>
          )}
          {error ? (
            <AppText variant="small" style={{ color: colors.danger }}>
              {error}
            </AppText>
          ) : null}
          <Button label={signingUp ? 'Create account' : 'Sign in'} onPress={submit} loading={busy} disabled={!ready} />
        </View>
        <View style={styles.switchRow}>
          <AppText variant="small" muted>
            {signingUp ? 'Already have an account?' : 'Have an invite code?'}
          </AppText>
          <Pressable
            accessibilityRole="button"
            onPress={switchMode}
            disabled={busy}
            style={({ pressed }) => [styles.switchLink, { opacity: busy ? 0.5 : pressed ? 0.7 : 1 }]}>
            <AppText
              variant="small"
              style={{ color: colors.accent, fontWeight: '700', textDecorationLine: 'underline' }}>
              {signingUp ? 'Sign in' : 'Create account'}
            </AppText>
          </Pressable>
        </View>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.md },
  switchRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    columnGap: spacing.sm,
  },
  switchLink: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.xs },
});
