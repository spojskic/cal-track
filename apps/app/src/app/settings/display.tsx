import { formatFoodMass, formatHeight, formatWeight, type UnitSystem } from '@ration/core';
import { Stack } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { UnitToggle } from '@/components/settings/body-fields';
import { KeyValueRow, Note } from '@/components/settings/rows';
import { errorMessage } from '@/components/settings/save-row';
import { ThemePicker } from '@/components/settings/theme-picker';
import { AppText, Card, Screen } from '@/components/ui';
import { useProfile, useUpdateProfile } from '@/data/profile';
import { spacing, useTheme } from '@/theme';

function UnitExamples({ system }: { system: UnitSystem }) {
  return (
    <View accessibilityLabel="Examples of the selected units">
      <KeyValueRow label="Body weight" value={formatWeight(72.5, system)} />
      <KeyValueRow label="Height" value={formatHeight(178, system)} />
      <KeyValueRow label="Food weight" value={formatFoodMass(150, system)} />
    </View>
  );
}

export default function DisplayScreen() {
  const { colors } = useTheme();
  const profileQ = useProfile();
  const update = useUpdateProfile();
  const profile = profileQ.data;
  // Show the pending choice immediately; fall back to the saved value.
  const system: UnitSystem = update.isPending ? (update.variables?.unit_system ?? profile?.unit_system ?? 'metric') : (profile?.unit_system ?? 'metric');

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: true, title: 'Display & units' }} />
      {profileQ.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} accessibilityLabel="Loading settings" />
        </View>
      ) : (
        <Card>
          <AppText variant="heading">Units</AppText>
          <UnitToggle
            label="Measurement system"
            value={system}
            onChange={(unit_system) => {
              if (profile) update.mutate({ unit_system });
            }}
          />
          <AppText variant="small" muted>
            Applies to body weight, height and food weights. Your data is always stored in metric units, so you can
            switch at any time without losing precision.
          </AppText>
          <UnitExamples system={system} />
          {update.error ? <Note tone="danger">{errorMessage(update.error)}</Note> : null}
        </Card>
      )}
      {/* The theme is saved on this device, so it does not wait for the profile. */}
      <Card>
        <AppText variant="heading">Appearance</AppText>
        <ThemePicker />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { paddingVertical: spacing.xxl, alignItems: 'center' },
});
