import { router, type Href } from 'expo-router';
import { Fragment, useMemo } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';

import { useAiGate } from '@/ai/use-ai-gate';
import {
  MORE_TWO_COLUMNS_FROM,
  MORE_WIDE_WIDTH,
  buildMoreSections,
  sectionsInColumn,
  type MoreSection,
} from '@/components/settings/more-sections';
import { Divider, LIST_CARD_PADDING, LIST_DIVIDER_INSET, NavRow } from '@/components/settings/rows';
import { AppText, Button, Card, Screen } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { spacing } from '@/theme';

/** Space between the sections of a column, and between the two columns of the wide layout. */
const SECTION_GAP = 20;

/**
 * The More screen: grouped lists (Training, Coach, Profile, Connections, App, Account), each a small heading above a card of rows.
 * What is listed, in which section and column lives in components/settings/more-sections.ts. One column on a phone; two columns
 * (Training / Coach / Connections, then Profile / App / Account) when the window is wide enough for the columns to fit their labels.
 */
export default function MoreScreen() {
  const { session, signOut } = useAuth();
  const ai = useAiGate();
  const { width } = useWindowDimensions();
  const twoColumns = width >= MORE_TWO_COLUMNS_FROM;
  const sections = useMemo(() => buildMoreSections({ aiEnabled: ai.enabled }), [ai.enabled]);

  const renderSection = (section: MoreSection) => (
    <Section key={section.id} section={section} email={session?.user.email} onSignOut={signOut} />
  );

  return (
    <Screen title="More" maxWidth={twoColumns ? MORE_WIDE_WIDTH : undefined}>
      {twoColumns ? (
        <View style={styles.columns}>
          <View style={styles.column}>{sectionsInColumn(sections, 'left').map(renderSection)}</View>
          <View style={styles.column}>{sectionsInColumn(sections, 'right').map(renderSection)}</View>
        </View>
      ) : (
        <View style={styles.stack}>{sections.map(renderSection)}</View>
      )}
    </Screen>
  );
}

function Section({ section, email, onSignOut }: { section: MoreSection; email: string | undefined; onSignOut: () => void }) {
  return (
    <View style={styles.section}>
      <AppText variant="small" muted accessibilityRole="header" style={styles.sectionLabel}>
        {section.label}
      </AppText>
      {section.id === 'account' ? (
        <Card>
          <AppText style={styles.email} accessibilityLabel={`Signed in as ${email ?? 'unknown'}`}>
            {email}
          </AppText>
          <Button label="Sign out" variant="secondary" onPress={onSignOut} />
        </Card>
      ) : (
        <Card style={styles.listCard}>
          {section.rows.map((row, i) => (
            <Fragment key={row.id}>
              {i > 0 ? <Divider inset={LIST_DIVIDER_INSET} /> : null}
              <NavRow
                variant="list"
                icon={row.symbol}
                label={row.label}
                description={row.description}
                badge={row.badge}
                // Typed routes are generated while the dev server runs, so a path is cast, as links.ts does for the workouts.
                onPress={() => router.push(row.href as unknown as Href)}
              />
            </Fragment>
          ))}
        </Card>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: SECTION_GAP },
  columns: { flexDirection: 'row', alignItems: 'flex-start', gap: SECTION_GAP },
  column: { flex: 1, minWidth: 0, gap: SECTION_GAP },
  section: { gap: spacing.sm },
  // A heading above its card (not inside it): small, semibold and muted.
  sectionLabel: { fontWeight: '600', letterSpacing: 0.3, paddingHorizontal: spacing.xs },
  listCard: { padding: LIST_CARD_PADDING, gap: 0 },
  email: { fontWeight: '600' },
});
