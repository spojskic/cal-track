import { router, type Href } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { useAiGate } from '@/ai/use-ai-gate';
import { Button } from '@/components/ui';
import { spacing } from '@/theme';

const RECIPE_ROUTE = '/ai/recipe' as unknown as Href;
const PHOTO_ROUTE = '/ai/photo' as unknown as Href;
const DESCRIBE_ROUTE = '/ai/describe' as unknown as Href;

/**
 * "Create recipe with AI" entry point. Renders NOTHING unless the AI gate is open (validated key on this
 * device + image-capable model). Mount it anywhere a recipe can be started, e.g. the recipes list or editor.
 */
export function AiRecipeButton({ label = 'Create recipe with AI' }: { label?: string }) {
  const gate = useAiGate();
  if (!gate.enabled) return null;
  return <Button label={label} variant="secondary" onPress={() => router.push(RECIPE_ROUTE)} />;
}

/** "Photo log" and "Describe a meal" buttons. Renders nothing unless the AI gate is open. */
export function AiMealButtons() {
  const gate = useAiGate();
  if (!gate.enabled) return null;
  return (
    <View style={styles.row}>
      <View style={styles.item}>
        <Button label="Photo log" variant="secondary" onPress={() => router.push(PHOTO_ROUTE)} />
      </View>
      <View style={styles.item}>
        <Button label="Describe a meal" variant="secondary" onPress={() => router.push(DESCRIBE_ROUTE)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  item: { flex: 1, minWidth: 150 },
});
