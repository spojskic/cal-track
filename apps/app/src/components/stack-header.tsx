import type { NativeStackHeaderProps } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

const BUTTON = 40;

/**
 * The app's own stack header, used for every screen that turns its header on (`<Stack.Screen options={{ headerShown: true }} />`).
 *
 * Why not the native one: on iOS 26 the system draws back / action buttons as "liquid glass" capsules that came out light
 * grey on our dark header and could not be themed. This header is plain React Native, so it looks the same on iOS, Android
 * and the web, follows the app theme, and still honours the usual options: `title`, `headerLeft`, `headerRight`,
 * `headerBackVisible`, `headerTitleAlign`, `headerShown`.
 */
export function StackHeader({ navigation, options, route, back }: NativeStackHeaderProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const modal = options.presentation === 'modal' || options.presentation === 'formSheet' || options.presentation === 'pageSheet';
  // A sheet starts below the status bar already; a full screen has to leave room for it.
  const top = modal ? spacing.sm : insets.top;

  const title = typeof options.headerTitle === 'string' ? options.headerTitle : (options.title ?? route.name);
  const canGoBack = back !== undefined;
  const tintColor = colors.text;

  const left = options.headerLeft
    ? options.headerLeft({ tintColor, canGoBack })
    : canGoBack && options.headerBackVisible !== false
      ? <BackButton onPress={() => navigation.goBack()} />
      : null;
  const right = options.headerRight ? options.headerRight({ tintColor, canGoBack }) : null;
  const centered = options.headerTitleAlign === 'center';

  return (
    <View style={[styles.bar, { paddingTop: top, backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
      <View style={styles.row}>
        <View style={[styles.side, styles.sideLeft]}>{left}</View>
        <AppText
          accessibilityRole="header"
          numberOfLines={1}
          style={[styles.title, centered && styles.titleCentered, { color: colors.text }]}>
          {title}
        </AppText>
        <View style={[styles.side, styles.sideRight]}>{right}</View>
      </View>
    </View>
  );
}

function BackButton({ onPress }: { onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Go back"
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [styles.back, { backgroundColor: pressed ? colors.border : colors.surfaceAlt }]}>
      <Text style={[styles.chevron, { color: colors.text }]}>{'\u2039'}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { borderBottomWidth: StyleSheet.hairlineWidth },
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, gap: spacing.sm },
  // Equal-width slots keep a centred title centred whatever the buttons are.
  side: { minWidth: BUTTON, flexDirection: 'row', alignItems: 'center' },
  sideLeft: { justifyContent: 'flex-start' },
  sideRight: { justifyContent: 'flex-end' },
  title: { flex: 1, fontSize: 18, fontWeight: '700' },
  titleCentered: { textAlign: 'center' },
  back: { width: BUTTON, height: BUTTON, borderRadius: BUTTON / 2, alignItems: 'center', justifyContent: 'center' },
  chevron: { fontSize: 30, lineHeight: 34, fontWeight: '400', marginTop: -2 },
});
