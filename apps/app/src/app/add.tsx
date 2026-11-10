import { router, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';

import { useAiGate } from '@/ai/use-ai-gate';
import { closeScreen, formatDateLabel } from '@/components/activity';
import { ADD_ACTIONS, ADD_SECTIONS } from '@/components/add-actions';
import { AppText, Button, Card } from '@/components/ui';
import { useSelectedDate } from '@/state/selected-date';
import { MAX_CONTENT_WIDTH, WIDE_BREAKPOINT, radius, spacing, useTheme } from '@/theme';

/** Dismisses the sheet and opens the destination in its place. */
function openAction(route: string) {
  router.replace(route as Href);
}

export default function AddSheet() {
  const gate = useAiGate();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_BREAKPOINT;
  const date = useSelectedDate((s) => s.date);
  const actions = ADD_ACTIONS.filter((a) => !a.ai || gate.enabled);

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={[styles.scroll, wide && styles.scrollWide]}
        keyboardShouldPersistTaps="handled">
        <View style={[styles.content, { maxWidth: wide ? 520 : MAX_CONTENT_WIDTH }]}>
          <AppText variant="small" muted>Adding to {formatDateLabel(date)}</AppText>

          {ADD_SECTIONS.map((section) => {
            const items = actions.filter((a) => a.section === section.key);
            if (items.length === 0) return null;
            return (
              <View key={section.key} style={styles.section}>
                <AppText variant="label" muted accessibilityRole="header">{section.title}</AppText>
                <Card style={styles.list}>
                  {items.map((action) => (
                    <Pressable
                      key={action.key}
                      accessibilityRole="button"
                      accessibilityLabel={`${action.label}. ${action.hint}`}
                      onPress={() => openAction(action.route)}
                      style={({ pressed }) => [
                        styles.row,
                        { backgroundColor: pressed ? colors.surfaceAlt : 'transparent' },
                      ]}>
                      <View style={[styles.icon, { backgroundColor: colors.surfaceAlt }]}>
                        <SymbolView name={action.symbol} size={22} tintColor={colors.primary} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <AppText variant="body" style={{ fontWeight: '600' }}>{action.label}</AppText>
                        <AppText variant="small" muted>{action.hint}</AppText>
                      </View>
                    </Pressable>
                  ))}
                </Card>
              </View>
            );
          })}

          <Button label="Cancel" variant="ghost" onPress={closeScreen} />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { flexGrow: 1, alignItems: 'center' },
  /** Wide web/tablet: a centred card instead of a full-bleed sheet. */
  scrollWide: { justifyContent: 'center', paddingVertical: spacing.xl },
  content: { width: '100%', padding: spacing.lg, gap: spacing.lg },
  section: { gap: spacing.sm },
  list: { padding: spacing.sm, gap: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
    padding: spacing.md,
    borderRadius: radius.md,
  },
  icon: { width: 40, height: 40, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
});
