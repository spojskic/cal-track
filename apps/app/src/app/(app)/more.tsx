import { Redirect, router, type Href } from 'expo-router';
import { Fragment, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { useAiGate } from '@/ai/use-ai-gate';
import { useDesktopShell } from '@/components/desktop/shell-context';
import { buildMoreSections, type MoreSection } from '@/components/settings/more-sections';
import { Divider, LIST_CARD_PADDING, LIST_DIVIDER_INSET, NavRow } from '@/components/settings/rows';
import { AppText, Button, Card, Screen } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { spacing } from '@/theme';

/** Space between the sections. */
const SECTION_GAP = 20;

/**
 * The More screen (phone): grouped lists (Training, Coach, Profile, Connections, App, Account), each a small heading above a card of
 * rows. What is listed and in which section lives in components/settings/more-sections.ts.
 *
 * A desktop window has no More page: the sidebar (components/desktop/Sidebar.tsx) lists all of these rows, and the account with Sign
 * out sits at its bottom. So an old link or bookmark to /more just opens the dashboard there.
 */
export default function MoreScreen() {
  const desktop = useDesktopShell();
  if (desktop) return <Redirect href="/" />;
  return <MoreContent />;
}

function MoreContent() {
  const { session, signOut } = useAuth();
  const ai = useAiGate();
  const sections = useMemo(() => buildMoreSections({ aiEnabled: ai.enabled }), [ai.enabled]);

  return (
    <Screen title="More">
      <View style={styles.stack}>
        {sections.map((section) => (
          <Section key={section.id} section={section} email={session?.user.email} onSignOut={signOut} />
        ))}
      </View>
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
  section: { gap: spacing.sm },
  // A heading above its card (not inside it): small, semibold and muted.
  sectionLabel: { fontWeight: '600', letterSpacing: 0.3, paddingHorizontal: spacing.xs },
  listCard: { padding: LIST_CARD_PADDING, gap: 0 },
  email: { fontWeight: '600' },
});
