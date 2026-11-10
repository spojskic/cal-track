import type { NativeStackHeaderProps } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useDesktopShell } from '@/components/desktop/shell-context';
import { breadcrumbParent } from '@/components/desktop/shell-routes';
import { Glyph } from '@/components/Glyph';
import { AppText } from '@/components/ui';
import { spacing, useTheme } from '@/theme';
import { DESKTOP_CONTENT_PADDING, PAGE_HEADER_HEIGHT } from '@/theme/desktop';

const BUTTON = 40;
/** The back button of the slim desktop header. */
const DESK_BUTTON = 28;

/**
 * The app's own stack header, used for every screen that turns its header on (`<Stack.Screen options={{ headerShown: true }} />`).
 *
 * Why not the native one: on iOS 26 the system draws back / action buttons as "liquid glass" capsules that came out light
 * grey on our dark header and could not be themed. This header is plain React Native, so it looks the same on iOS, Android
 * and the web, follows the app theme, and still honours the usual options: `title`, `headerLeft`, `headerRight`,
 * `headerBackVisible`, `headerTitleAlign`, `headerShown`.
 */
export function StackHeader(props: NativeStackHeaderProps) {
  const desktop = useDesktopShell();
  return desktop ? <DesktopStackHeader {...props} /> : <PhoneStackHeader {...props} />;
}

/** The header of the phone (and of every route drawn without the desktop shell): exactly what it has always been. */
function PhoneStackHeader({ navigation, options, route, back }: NativeStackHeaderProps) {
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

/**
 * The header inside the desktop shell: a slim strip (PAGE_HEADER_HEIGHT) like the page header of the dashboard, diary and foods
 * pages, with the title at the left (after a small back button when there is a page to go back to, and the muted name of the parent
 * page: "Settings > Display & units") and the `headerRight` actions at the right. The window's top inset is already kept free by the
 * shell, so none is added here.
 */
function DesktopStackHeader({ navigation, options, route, back }: NativeStackHeaderProps) {
  const { colors, shape } = useTheme();
  const title = typeof options.headerTitle === 'string' ? options.headerTitle : (options.title ?? route.name);
  const canGoBack = back !== undefined;
  const tintColor = colors.text;
  // From the route NAME of this header's own screen ('settings/display', 'workouts/[id]'), not from the address bar: while a screen is
  // leaving, the address already belongs to the next one.
  const parent = breadcrumbParent(`/${route.name}`);

  const left = options.headerLeft
    ? options.headerLeft({ tintColor, canGoBack })
    : canGoBack && options.headerBackVisible !== false
      ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={6}
          onPress={() => navigation.goBack()}
          style={({ pressed }) => [
            styles.deskBack,
            { backgroundColor: pressed ? colors.border : colors.surfaceAlt, borderRadius: shape.circle(DESK_BUTTON) },
          ]}>
          <Glyph name="chevron-left" size={18} color={colors.text} />
        </Pressable>
      )
      : null;
  const right = options.headerRight ? options.headerRight({ tintColor, canGoBack }) : null;

  return (
    <View style={[styles.deskBar, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
      <View style={styles.deskRow}>
        {left}
        <View style={styles.deskTitleRow}>
          {parent && parent !== title ? (
            <>
              <Text numberOfLines={1} style={[styles.deskParent, { color: colors.textMuted }]}>
                {parent}
              </Text>
              <Glyph name="chevron-right" size={12} color={colors.textMuted} strokeWidth={2.4} />
            </>
          ) : null}
          <Text accessibilityRole="header" numberOfLines={1} style={[styles.deskTitle, { color: colors.text }]}>
            {title}
          </Text>
        </View>
        {right ? <View style={styles.deskRight}>{right}</View> : null}
      </View>
    </View>
  );
}

function BackButton({ onPress }: { onPress: () => void }) {
  const { colors, shape } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Go back"
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [
        styles.back,
        { backgroundColor: pressed ? colors.border : colors.surfaceAlt, borderRadius: shape.circle(BUTTON) },
      ]}>
      <Glyph name="chevron-left" size={24} color={colors.text} />
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
  back: { width: BUTTON, height: BUTTON, alignItems: 'center', justifyContent: 'center' },
  // The desktop header (same measurements as the page header of components/panel.tsx, so the pages line up).
  deskBar: { height: PAGE_HEADER_HEIGHT, borderBottomWidth: 1, justifyContent: 'center' },
  // Always starts at the left edge of the content area (back button and title) and ends at its right edge (actions): it is not
  // centred in the page's content column, so the strip reads the same on every page and at every window width.
  deskRow: {
    width: '100%',
    paddingHorizontal: DESKTOP_CONTENT_PADDING,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  deskBack: { width: DESK_BUTTON, height: DESK_BUTTON, alignItems: 'center', justifyContent: 'center' },
  deskTitleRow: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6 },
  deskParent: { flexShrink: 1, fontSize: 13, fontWeight: '400' },
  deskTitle: { flexShrink: 1, fontSize: 15, fontWeight: '600' },
  deskRight: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
});
