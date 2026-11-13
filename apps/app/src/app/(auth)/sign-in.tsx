import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

import { TextField } from '@/components/forms';
import { AppText, Button, Card, Screen } from '@/components/ui';
import { createAccount } from '@/data/signup';
import { useAuth } from '@/lib/auth';
import { APP_URL } from '@/lib/app-url';
import { supabase } from '@/lib/supabase';
import {
  formatInviteCodeInput,
  hasErrors,
  isPlausibleEmail,
  validateSignUp,
  type SignUpField,
  type SignUpFieldErrors,
} from '@/lib/signup';
import { spacing, useTheme } from '@/theme';

type Mode = 'sign-in' | 'sign-up' | 'forgot';

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
  const params = useLocalSearchParams<{ code?: string | string[]; email?: string | string[]; reset?: string | string[] }>();
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
  // The invite e-mail's link (?code=...&email=...) opens the CREATE ACCOUNT form directly: a link that carries a
  // code is by definition an invitation, so nobody has to find the Create account toggle after arriving.
  const [mode, setMode] = useState<Mode>(firstParam(params.code) ? 'sign-up' : 'sign-in');
  // The reset-password screen sends ?reset=1 after the password was changed: the user ends their reset flow here.
  const [resetDone, setResetDone] = useState(firstParam(params.reset) === '1');
  // The Forgot password form hides its fields once the e-mail went out; only "Back to sign in" remains.
  const [resetSent, setResetSent] = useState(false);
  const email = typedEmail ?? firstParam(params.email);
  const inviteCode = typedCode ?? formatInviteCodeInput(firstParam(params.code));

  const signingUp = mode === 'sign-up';
  const forgotting = mode === 'forgot';

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

  function switchMode(next?: Mode) {
    if (busy) return;
    setMode(next ?? (mode === 'sign-in' ? 'sign-up' : 'sign-in'));
    // The e-mail address carries over; everything else starts empty and no old error stays on screen. The
    // invite code only clears when the user had typed it: a code that came from the invite link stays, it is
    // what they came with.
    setPassword('');
    setConfirmPassword('');
    if (typedCode !== null) setTypedCode('');
    setFieldErrors({});
    setError(null);
    setResetDone(false);
    setResetSent(false);
  }

  async function submitForgot() {
    if (!isPlausibleEmail(email)) {
      setFieldErrors({ email: 'Enter a valid e-mail address.' });
      setError(null);
      return;
    }
    setBusy(true);
    setError(null);
    // The link opens the web app's /reset-password screen (same pattern as the invite e-mail's link): the
    // recovery token is exchanged there and the password is set on the web app, whatever device opened the mail.
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${APP_URL}/reset-password`,
    });
    setBusy(false);
    if (resetError) setError(resetError.message);
    else setResetSent(true);
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
    if (forgotting) return void submitForgot();
    void (signingUp ? submitSignUp() : submitSignIn());
  }

  const ready = signingUp
    ? Boolean(email && password && confirmPassword && inviteCode)
    : Boolean(email && password);

  return (
    <Screen title="Ration" safeTop>
      <Card>
        <AppText variant="heading">{signingUp ? 'Create account' : forgotting ? 'Reset password' : 'Sign in'}</AppText>
        <AppText muted variant="small">
          {signingUp
            ? 'You need an invite code from the app owner to create an account.'
            : forgotting
              ? 'Enter your e-mail and we send you a reset link. It works for an hour.'
              : 'New here? Ask the app owner for an invite code, then choose Create account.'}
        </AppText>
        {resetDone ? (
          <AppText variant="small" style={{ color: colors.success }}>
            Password updated. Sign in with your new password.
          </AppText>
        ) : null}
        {forgotting && resetSent ? (
          <AppText variant="small" style={{ color: colors.success }}>
            Check your inbox — the reset link is on its way to {email.trim()}.
          </AppText>
        ) : null}
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
          ) : forgotting ? (
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
              returnKeyType="go"
              onSubmitEditing={submit}
              error={fieldErrors.email}
            />
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
          {!(forgotting && resetSent) ? (
            <Button
              label={signingUp ? 'Create account' : forgotting ? 'Send reset link' : 'Sign in'}
              onPress={submit}
              loading={busy}
              disabled={forgotting ? !email : !ready}
            />
          ) : null}
        </View>
        <View style={styles.switchRow}>
          <AppText variant="small" muted>
            {signingUp ? 'Already have an account?' : forgotting ? 'Remembered it after all?' : 'Have an invite code?'}
          </AppText>
          <Pressable
            accessibilityRole="button"
            onPress={() => switchMode()}
            disabled={busy}
            style={({ pressed }) => [styles.switchLink, { opacity: busy ? 0.5 : pressed ? 0.7 : 1 }]}>
            <AppText
              variant="small"
              style={{ color: colors.accent, fontWeight: '700', textDecorationLine: 'underline' }}>
              {signingUp ? 'Sign in' : forgotting ? 'Back to sign in' : 'Create account'}
            </AppText>
          </Pressable>
        </View>
        {mode === 'sign-in' ? (
          <View style={styles.switchRow}>
            <Pressable
              accessibilityRole="button"
              onPress={() => switchMode('forgot')}
              disabled={busy}
              style={({ pressed }) => [styles.switchLink, { opacity: busy ? 0.5 : pressed ? 0.7 : 1 }]}>
              <AppText
                variant="small"
                style={{ color: colors.accent, fontWeight: '700', textDecorationLine: 'underline' }}>
                Forgot password?
              </AppText>
            </Pressable>
          </View>
        ) : null}
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
