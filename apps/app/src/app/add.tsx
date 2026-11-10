import { router, type Href } from 'expo-router';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';

import { useAiGate } from '@/ai/use-ai-gate';
import { closeScreen, formatDateLabel } from '@/components/activity';
import { AppText, Button, Card } from '@/components/ui';
import { useSelectedDate } from '@/state/selected-date';
import { MAX_CONTENT_WIDTH, WIDE_BREAKPOINT, radius, spacing, useTheme } from '@/theme';

type SectionKey = 'food' | 'activity';

interface Action {
  key: string;
  section: SectionKey;
  label: string;
  hint: string;
  /** Destination route. Built by other agents for the food / AI entries. */
  route: string;
  symbol: SymbolViewProps['name'];
  /** AI actions are hidden unless useAiGate().enabled (valid key + vision-capable model). */
  ai?: boolean;
}

const SECTIONS: { key: SectionKey; title: string }[] = [
  { key: 'food', title: 'Food' },
  { key: 'activity', title: 'Activity and health' },
];

const ACTIONS: Action[] = [
  {
    key: 'search',
    section: 'food',
    label: 'Search food',
    hint: 'Find a food and log it',
    route: '/search',
    symbol: { ios: 'magnifyingglass', android: 'search', web: 'search' },
  },
  {
    key: 'barcode',
    section: 'food',
    label: 'Scan barcode',
    hint: 'Look up a packaged product',
    route: '/scan',
    symbol: { ios: 'barcode.viewfinder', android: 'qr_code_scanner', web: 'qr_code_scanner' },
  },
  {
    key: 'custom-food',
    section: 'food',
    label: 'Create custom food',
    hint: 'Add your own food with nutrition facts',
    route: '/food/new',
    symbol: { ios: 'plus.circle.fill', android: 'add_circle', web: 'add_circle' },
  },
  // ---- AI actions (routes /ai/photo, /ai/describe and /ai/label).
  // Keep `ai: true` so the useAiGate() filter below hides them unless AI is enabled.
  {
    key: 'photo',
    section: 'food',
    label: 'Photo log',
    hint: 'Snap your meal, AI estimates it',
    route: '/ai/photo',
    symbol: { ios: 'camera.fill', android: 'photo_camera', web: 'photo_camera' },
    ai: true,
  },
  {
    key: 'describe',
    section: 'food',
    label: 'Describe meal',
    hint: 'Type what you ate, AI fills it in',
    route: '/ai/describe',
    symbol: { ios: 'text.bubble.fill', android: 'chat', web: 'chat' },
    ai: true,
  },
  {
    key: 'label',
    section: 'food',
    label: 'Scan nutrition label',
    hint: 'Photograph a label, AI fills in a new food',
    route: '/ai/label',
    symbol: { ios: 'doc.text.viewfinder', android: 'document_scanner', web: 'document_scanner' },
    ai: true,
  },
  // ---- end AI placeholders
  {
    key: 'exercise',
    section: 'activity',
    label: 'Add exercise',
    hint: 'Log a workout',
    route: '/exercise/new',
    symbol: { ios: 'figure.run', android: 'directions_run', web: 'directions_run' },
  },
  {
    key: 'biometric',
    section: 'activity',
    label: 'Add biometric',
    hint: 'Weight, blood pressure, glucose, ...',
    route: '/biometric/new',
    symbol: { ios: 'waveform.path.ecg', android: 'monitor_heart', web: 'monitor_heart' },
  },
  {
    key: 'note',
    section: 'activity',
    label: 'Add note',
    hint: 'Write a diary note',
    route: '/note/new',
    symbol: { ios: 'note.text', android: 'sticky_note_2', web: 'sticky_note_2' },
  },
  {
    key: 'water',
    section: 'activity',
    label: 'Add water',
    hint: 'Log a drink',
    route: '/water/new',
    symbol: { ios: 'drop.fill', android: 'water_drop', web: 'water_drop' },
  },
];

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
  const actions = ACTIONS.filter((a) => !a.ai || gate.enabled);

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={[styles.scroll, wide && styles.scrollWide]}
        keyboardShouldPersistTaps="handled">
        <View style={[styles.content, { maxWidth: wide ? 520 : MAX_CONTENT_WIDTH }]}>
          <AppText variant="small" muted>Adding to {formatDateLabel(date)}</AppText>

          {SECTIONS.map((section) => {
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
