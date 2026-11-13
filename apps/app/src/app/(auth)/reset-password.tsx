import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';

import { TextField } from '@/components/forms';
import { AppText, Button, Card, Screen } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { hasErrors, validateNewPassword } from '@/lib/signup';
import { supabase } from '@/lib/supabase';
import { spacing, useTheme } from '@/theme';

/**
 * The screen the password-reset e-mail's link opens (APP_URL/reset-password, the web app on every device).
 *
 * The recovery link logs this browser in with a recovery session before anything renders (supabase-js exchanges
 * the token in the URL hash while the auth state loads), so a session here means the link was valid and the form
 * can set the new password with `updateUser`. No session means the link is expired, used up or hand-typed: show
 * the expired state. After the password is set the session is signed out and the user lands on the sign-in screen
 * with a confirmation (?reset=1), to sign in with the password they just chose.
 */
export default function ResetPasswordScreen() {
  const { session, loading, signOut } = useAuth();
  const { colors } = useTheme();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ password?: string; confirmPassword?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const expired = !loading && !session;

  function edit(field: 'password' | 'confirmPassword', set: (value: string) => void) {
    return (value: string) => {
      set(value);
      setFieldErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
      setError(null);
    };
  }

  async function submit() {
    if (busy) return;
    const problems = validateNewPassword(password, confirmPassword);
    setFieldErrors(problems);
    setError(null);
    if (hasErrors(problems)) return;

    setBusy(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    // The recovery session did its one job: sign it out so nothing stays logged in, then the confirmation on the
    // sign-in screen asks the user to sign in with the password they just chose.
    await signOut();
    router.replace('/sign-in?reset=1');
  }

  return (
    <Screen title="Ration" safeTop>
      <Card>
        <AppText variant="heading">{expired ? 'Link expired' : 'Set a new password'}</AppText>
        <AppText muted variant="small">
          {expired
            ? 'This password reset link has expired or was already used. Request a new one from the sign-in screen.'
            : 'Choose a new password for your account.'}
        </AppText>
        {expired ? (
          <View style={styles.backRow}>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.replace('/sign-in')}
              style={({ pressed }) => [styles.backLink, { opacity: pressed ? 0.7 : 1 }]}>
              <AppText variant="small" style={{ color: colors.accent, fontWeight: '700', textDecorationLine: 'underline' }}>
                Back to sign in
              </AppText>
            </Pressable>
          </View>
        ) : (
          <View style={styles.form}>
            <TextField
              label="New password"
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
              label="Confirm new password"
              value={confirmPassword}
              onChangeText={edit('confirmPassword', setConfirmPassword)}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="new-password"
              textContentType="newPassword"
              returnKeyType="go"
              onSubmitEditing={submit}
              error={fieldErrors.confirmPassword}
            />
            {error ? (
              <AppText variant="small" style={{ color: colors.danger }}>
                {error}
              </AppText>
            ) : null}
            <Button label="Set new password" onPress={submit} loading={busy} disabled={!password || !confirmPassword} />
          </View>
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.md },
  backRow: { flexDirection: 'row' },
  backLink: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.xs },
});
