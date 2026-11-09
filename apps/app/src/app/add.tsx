import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { useAiGate } from '@/ai/use-ai-gate';
import { AppText, Card, Screen } from '@/components/ui';
import { radius, spacing, useTheme } from '@/theme';

interface Action {
  key: string;
  label: string;
  hint: string;
  ai?: boolean;
}

const ACTIONS: Action[] = [
  { key: 'search', label: 'Search food', hint: 'Find a food and log it' },
  { key: 'barcode', label: 'Scan barcode', hint: 'Look up a packaged product' },
  { key: 'photo', label: 'Photo log', hint: 'Snap your meal, AI estimates it', ai: true },
  { key: 'describe', label: 'Describe meal', hint: 'Type what you ate, AI fills it in', ai: true },
  { key: 'exercise', label: 'Add exercise', hint: 'Log a workout' },
  { key: 'biometric', label: 'Add biometric', hint: 'Weight, blood pressure, ...' },
  { key: 'note', label: 'Add note', hint: 'Write a diary note' },
  { key: 'water', label: 'Add water', hint: 'Log a drink' },
];

export default function AddSheet() {
  const gate = useAiGate();
  const { colors } = useTheme();
  const actions = ACTIONS.filter((a) => !a.ai || gate.enabled);

  return (
    <Screen>
      <Card style={styles.list}>
        {actions.map((action) => (
          <Pressable
            key={action.key}
            accessibilityRole="button"
            onPress={() => router.back()}
            style={({ pressed }) => [styles.row, { backgroundColor: pressed ? colors.surfaceAlt : 'transparent' }]}>
            <View style={{ flex: 1 }}>
              <AppText variant="body" style={{ fontWeight: '600' }}>{action.label}</AppText>
              <AppText variant="small" muted>{action.hint}</AppText>
            </View>
          </Pressable>
        ))}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { padding: spacing.sm, gap: 0 },
  row: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, borderRadius: radius.md },
});
