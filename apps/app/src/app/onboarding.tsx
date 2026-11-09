import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText, Button, Screen } from '@/components/ui';
import { Note } from '@/components/settings/rows';
import { safeResolve } from '@/components/settings/inputs';
import {
  STEP_SUBTITLES,
  STEP_TITLES,
  TOTAL_STEPS,
  initialForm,
  parseOnboarding,
  stepHasErrors,
  toResolveInput,
  toSaveInput,
  type OnboardingForm,
} from '@/components/settings/onboarding-model';
import {
  StepActivity,
  StepBasics,
  StepGoal,
  StepMacros,
  StepSummary,
  StepWeight,
} from '@/components/settings/onboarding-steps';
import { useActiveWeightGoal, useMacroTarget } from '@/data/goals';
import { useProfile } from '@/data/profile';
import { useCompleteOnboarding } from '@/data/targets';
import { useLatestBody } from '@/data/weight';
import { todayISO } from '@/state/selected-date';
import { MAX_CONTENT_WIDTH, spacing, useTheme } from '@/theme';

function leave() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

function Wizard({ initial, canCancel }: { initial: OnboardingForm; canCancel: boolean }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [form, setForm] = useState<OnboardingForm>(initial);
  const [step, setStep] = useState(1);
  const [showErrors, setShowErrors] = useState(false);
  const complete = useCompleteOnboarding();

  const today = todayISO();
  const parsed = parseOnboarding(form, today);
  const result = safeResolve(toResolveInput(form, parsed, today));
  const macroInvalid = parsed.macroMode === null || (result?.macroError ?? null) !== null;

  const update = (patch: Partial<OnboardingForm>) => setForm((f) => ({ ...f, ...patch }));

  const blocked = stepHasErrors(parsed, step) || (step === 5 && macroInvalid);

  const goTo = (target: number) => {
    setShowErrors(false);
    setStep(target);
  };

  const next = () => {
    if (blocked) {
      setShowErrors(true);
      return;
    }
    goTo(step + 1);
  };

  const finish = async () => {
    if (!result || macroInvalid) return;
    const input = toSaveInput(form, parsed, result.macroMode);
    if (!input) return;
    try {
      await complete.mutateAsync(input);
      router.replace('/');
    } catch {
      // The error is shown in the summary via complete.error.
    }
  };

  const stepProps = { form, update, parsed, showErrors };
  const last = step === TOTAL_STEPS;

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: colors.background, paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <Screen key={step}>
        <View style={styles.progress} accessibilityRole="progressbar" accessibilityLabel={`Step ${step} of ${TOTAL_STEPS}`}>
          <View style={styles.segments}>
            {Array.from({ length: TOTAL_STEPS }, (_, i) => (
              <View
                key={i}
                style={[styles.segment, { backgroundColor: i < step ? colors.primary : colors.track }]}
              />
            ))}
          </View>
          <AppText variant="label" muted>{`Step ${step} of ${TOTAL_STEPS}`}</AppText>
        </View>
        <View style={styles.titles}>
          <AppText variant="title" accessibilityRole="header">{STEP_TITLES[step - 1]}</AppText>
          <AppText muted>{STEP_SUBTITLES[step - 1]}</AppText>
        </View>

        {step === 1 ? <StepBasics {...stepProps} /> : null}
        {step === 2 ? <StepWeight {...stepProps} /> : null}
        {step === 3 ? <StepActivity {...stepProps} /> : null}
        {step === 4 ? <StepGoal {...stepProps} result={result} /> : null}
        {step === 5 ? <StepMacros {...stepProps} result={result} /> : null}
        {step === 6 ? <StepSummary {...stepProps} result={result} /> : null}

        {complete.error ? (
          <Note tone="danger">
            {complete.error instanceof Error ? complete.error.message : 'Could not save your setup. Please try again.'}
          </Note>
        ) : null}
      </Screen>

      <View
        style={[
          styles.footer,
          {
            backgroundColor: colors.surface,
            borderTopColor: colors.border,
            paddingBottom: Math.max(insets.bottom, spacing.md),
          },
        ]}>
        <View style={styles.footerInner}>
          {step > 1 ? (
            <View style={styles.back}>
              <Button label="Back" variant="secondary" onPress={() => goTo(step - 1)} disabled={complete.isPending} />
            </View>
          ) : canCancel ? (
            <View style={styles.back}>
              <Button label="Cancel" variant="secondary" onPress={leave} />
            </View>
          ) : null}
          <View style={styles.forward}>
            {last ? (
              <Button
                label="Finish setup"
                onPress={finish}
                loading={complete.isPending}
                disabled={result === null || macroInvalid}
              />
            ) : (
              <Button label="Next" onPress={next} />
            )}
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

export default function OnboardingScreen() {
  const { colors } = useTheme();
  const profileQ = useProfile();
  const bodyQ = useLatestBody();
  const goalQ = useActiveWeightGoal();
  const macroQ = useMacroTarget();
  const loading = profileQ.isLoading || bodyQ.isLoading || goalQ.isLoading || macroQ.isLoading;

  if (loading) {
    return (
      <View style={[styles.loading, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
        <ActivityIndicator color={colors.primary} accessibilityLabel="Loading" />
      </View>
    );
  }

  const initial = initialForm({
    profile: profileQ.data,
    body: bodyQ.data,
    goal: goalQ.data,
    macroMode: macroQ.data?.mode,
  });
  return <Wizard initial={initial} canCancel={Boolean(profileQ.data?.onboarded)} />;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  progress: { gap: spacing.sm },
  segments: { flexDirection: 'row', gap: spacing.xs },
  segment: { flex: 1, height: 6, borderRadius: 3 },
  titles: { gap: spacing.xs },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: spacing.md, paddingHorizontal: spacing.lg },
  footerInner: {
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: 'center',
    flexDirection: 'row',
    gap: spacing.md,
  },
  back: { flex: 1 },
  forward: { flex: 2 },
});
