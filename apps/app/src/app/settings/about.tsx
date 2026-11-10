import Constants from 'expo-constants';
import { Stack } from 'expo-router';
import type { ReactNode } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';

import { Divider, KeyValueRow, Note } from '@/components/settings/rows';
import { MEDICAL_DISCLAIMER } from '@/components/settings/options';
import { AppText, Card, Screen } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

function ExternalLink({ label, url }: { label: string; url: string }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${label}. Opens in your browser`}
      onPress={() => {
        Linking.openURL(url).catch(() => {});
      }}
      style={({ pressed }) => [styles.link, { opacity: pressed ? 0.7 : 1 }]}>
      <AppText variant="body" style={{ color: colors.accent, textDecorationLine: 'underline' }}>{label}</AppText>
    </Pressable>
  );
}

function Source({
  name,
  license,
  children,
}: {
  name: string;
  license: string;
  children?: ReactNode;
}) {
  return (
    <View style={styles.source}>
      <AppText variant="body" style={styles.bold}>{name}</AppText>
      <AppText variant="small" muted>{license}</AppText>
      {children}
    </View>
  );
}

/** "abc1234, 10 Nov 2026 16:52": which commit this copy of the app was built from, and when. */
function buildLabel(): string {
  const build = (Constants.expoConfig?.extra as { build?: { commit?: string; builtAt?: string } } | undefined)?.build;
  if (!build?.commit) return 'unknown';
  const when = build.builtAt ? new Date(build.builtAt) : null;
  const time = when && !Number.isNaN(when.getTime()) ? `, ${when.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : '';
  return `${build.commit}${time}`;
}

export default function AboutScreen() {
  const version = Constants.expoConfig?.version ?? 'unknown';
  const name = Constants.expoConfig?.name ?? 'Cal Track';

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: true, title: 'About' }} />
      <Card>
        <AppText variant="heading">{name}</AppText>
        <KeyValueRow label="Version" value={version} />
        <KeyValueRow label="Build" value={buildLabel()} />
        <AppText variant="small" muted>
          A nutrition tracker for food, exercise and body measurements.
        </AppText>
      </Card>

      <Card>
        <AppText variant="heading">Food data sources</AppText>
        <Source
          name="USDA FoodData Central"
          license="Public domain (CC0). Data courtesy of the U.S. Department of Agriculture.">
          <ExternalLink label="fdc.nal.usda.gov" url="https://fdc.nal.usda.gov/" />
        </Source>
        <Divider />
        <Source
          name="Canadian Nutrient File"
          license="Contains information licensed under the Open Government Licence - Canada. Source: Health Canada.">
          <ExternalLink label="Open Government Licence - Canada" url="https://open.canada.ca/en/open-government-licence-canada" />
        </Source>
        <Divider />
        <Source
          name="Open Food Facts"
          license="Packaged-food data is licensed under the Open Database License (ODbL). Individual contents are under the Database Contents License.">
          <ExternalLink label="Data from Open Food Facts" url="https://world.openfoodfacts.org/" />
          <ExternalLink label="Open Database License (ODbL)" url="https://opendatacommons.org/licenses/odbl/1-0/" />
        </Source>
        <Divider />
        <Source
          name="Compendium of Physical Activities"
          license="Exercise energy estimates use MET values from the Compendium of Physical Activities.">
          <ExternalLink label="pacompendium.com" url="https://pacompendium.com/" />
        </Source>
      </Card>

      <Card>
        <AppText variant="heading">Reference intakes</AppText>
        <AppText variant="small" muted>
          Nutrient targets are based on the Dietary Reference Intakes (National Academies of Sciences, Engineering,
          and Medicine) and the Dietary Guidelines for Americans. They are general guidance for healthy people.
        </AppText>
      </Card>

      <Note tone="warning">{MEDICAL_DISCLAIMER}</Note>
    </Screen>
  );
}

const styles = StyleSheet.create({
  source: { gap: spacing.xs },
  link: { minHeight: 36, justifyContent: 'center' },
  bold: { fontWeight: '700' },
});
