import { SymbolView } from 'expo-symbols';
import { StyleSheet, View } from 'react-native';

import type { RefusalCategory } from '@/data/coach';
import { AppText } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

const TITLES: Record<RefusalCategory, string> = {
  off_topic: 'Outside what I can help with',
  medical_red_flag: 'Please talk to a professional',
  eating_disorder_risk: 'Support is available',
};

/**
 * A fixed safety / scope response from the coach. Deliberately NOT styled like a normal assistant bubble:
 * a neutral, full-width card with an info icon, so nobody mistakes it for coaching advice.
 */
export function RefusalCard({ text, category }: { text: string; category: RefusalCategory }) {
  const { colors, radius } = useTheme();
  const title = TITLES[category];
  return (
    <View
      accessible
      accessibilityLabel={`Coach notice. ${title}. ${text}`}
      style={[styles.card, { backgroundColor: colors.surfaceAlt, borderColor: colors.border, borderRadius: radius.lg }]}>
      <View style={styles.header}>
        <SymbolView
          name={{ ios: 'info.circle', android: 'info', web: 'info' }}
          size={20}
          tintColor={colors.accent}
        />
        <AppText variant="small" style={[styles.title, { color: colors.accent }]}>
          {title}
        </AppText>
      </View>
      <AppText selectable>{text}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    alignSelf: 'stretch',
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { fontWeight: '800' },
});
