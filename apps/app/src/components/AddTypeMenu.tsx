import { router, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, View } from 'react-native';

import { useAiGate } from '@/ai/use-ai-gate';
import { ADD_ACTIONS, ADD_SECTIONS } from '@/components/add-actions';
import { runAfterModal, Sheet } from '@/components/diary/Sheet';
import { AppText } from '@/components/ui';
import { radius, spacing, useTheme } from '@/theme';

/** Actions that understand `mealGroupId`, so the meal chosen on the Add food screen follows the user. */
const TAKES_MEAL_GROUP = new Set(['barcode', 'custom-food']);

/**
 * The "..." menu of the Add food screen: switch to another way of adding (scan a barcode, exercise, a note, the AI
 * helpers ...). It lists the same actions as the "+" sheet of the tab bar, minus "Search food" (that is where the user is).
 * AI entries are hidden unless the AI gate is open, like everywhere else.
 */
export function AddTypeMenu({
  visible,
  onClose,
  mealGroupId,
}: {
  visible: boolean;
  onClose: () => void;
  mealGroupId?: string;
}) {
  const gate = useAiGate();
  const { colors } = useTheme();
  const actions = ADD_ACTIONS.filter((a) => a.key !== 'search' && (!a.ai || gate.enabled));

  const choose = (key: string, route: string) => {
    onClose();
    // Two native modals cannot be swapped in the same tick on iOS: wait until the sheet has closed, then replace this screen.
    runAfterModal(() => {
      const withMeal = mealGroupId && TAKES_MEAL_GROUP.has(key);
      router.replace((withMeal ? { pathname: route, params: { mealGroupId } } : route) as Href);
    });
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Add something else" subtitle="Change what you are adding">
      {ADD_SECTIONS.map((section) => {
        const items = actions.filter((a) => a.section === section.key);
        if (items.length === 0) return null;
        return (
          <View key={section.key} style={styles.section}>
            <AppText variant="label" muted accessibilityRole="header">
              {section.title}
            </AppText>
            {items.map((action) => (
              <Pressable
                key={action.key}
                accessibilityRole="button"
                accessibilityLabel={action.label}
                onPress={() => choose(action.key, action.route)}
                style={({ pressed }) => [styles.row, { backgroundColor: pressed ? colors.surfaceAlt : 'transparent' }]}>
                <View style={[styles.icon, { backgroundColor: colors.surfaceAlt }]}>
                  <SymbolView name={action.symbol} size={20} tintColor={colors.primary} />
                </View>
                <View style={styles.text}>
                  <AppText variant="body" style={styles.label}>
                    {action.label}
                  </AppText>
                  <AppText variant="small" muted>
                    {action.hint}
                  </AppText>
                </View>
              </Pressable>
            ))}
          </View>
        );
      })}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.xs, marginBottom: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 52, paddingVertical: spacing.sm, paddingHorizontal: spacing.xs, borderRadius: radius.md },
  icon: { width: 36, height: 36, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1 },
  label: { fontWeight: '600' },
});
