import { router } from 'expo-router';
import { TabList, TabSlot, TabTrigger, Tabs, type TabTriggerSlotProps } from 'expo-router/ui';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import type { ReactNode } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DASHBOARD_ROW, DIARY_ROW, FOODS_ROW } from '@/components/desktop/sidebar-model';
import { useDesktopShell } from '@/components/desktop/shell-context';
import { tabBadgeText } from '@/components/friends/friends-view';
import { Glyph } from '@/components/Glyph';
import { useFriendRequestCount } from '@/data/friends';
import { spacing, useTheme } from '@/theme';

interface NavItem {
  name: string;
  href: '/' | '/diary' | '/foods' | '/more';
  label: string;
  symbol: SymbolViewProps['name'];
}

// The phone's tabs. The icons of the first three are shared with the desktop sidebar (components/desktop/sidebar-model.ts).
const ITEMS: NavItem[] = [
  { name: 'index', href: '/', label: DASHBOARD_ROW.label, symbol: DASHBOARD_ROW.symbol },
  { name: 'diary', href: '/diary', label: DIARY_ROW.label, symbol: DIARY_ROW.symbol },
  { name: 'foods', href: '/foods', label: FOODS_ROW.label, symbol: FOODS_ROW.symbol },
  { name: 'more', href: '/more', label: 'More', symbol: { ios: 'ellipsis.circle.fill', android: 'more_horiz', web: 'more_horiz' } },
];

/**
 * The direct children of `Tabs asChild` / `TabList asChild` are merged with the library's own styles by a Slot that
 * spreads `style` into an object: an ARRAY style would end up as `{0: ..., 1: ...}` and crash the web build
 * ("Failed to set an indexed property [0] on CSSStyleDeclaration"). Always pass a flat object to those children.
 */
function flat(...styles: StyleProp<ViewStyle>[]): ViewStyle {
  return StyleSheet.flatten(styles) as ViewStyle;
}

function openAddSheet() {
  router.push('/add');
}

/**
 * The shell of the three tab pages (Dashboard, Diary, Foods) and More.
 *
 * Phone: the page above a bottom tab bar with a raised "+" button in the middle.
 *
 * Desktop (the desktop shell is on, see components/desktop/DesktopFrame.tsx): the sidebar and status bar are drawn once, above the
 * whole navigator, by the root layout, so this layout only renders the routed page. The tab triggers are still registered, in a
 * hidden list, because expo-router/ui builds the tab screens from them: without a trigger a route is not a screen of the Tabs.
 * The More tab is registered too (its screen redirects to the dashboard on a desktop: the sidebar has everything More lists).
 */
export function AppShell({ children }: { children?: ReactNode }) {
  const desktop = useDesktopShell();
  const { colors, shape } = useTheme();
  const insets = useSafeAreaInsets();
  // The notification: a count on the More tab while friend requests wait for an answer (they are on More > Friends).
  const friendRequests = useFriendRequestCount();
  const left = ITEMS.slice(0, 2);
  const right = ITEMS.slice(2);

  // IMPORTANT: expo-router/ui finds the <TabTrigger>s by walking the ELEMENT tree at render time
  // (Tabs > TabList > direct children). Triggers hidden inside a custom component (or inside an extra <View>
  // between TabList and the trigger) are never registered, and pressing them silently does nothing.
  // So `Tabs`/`TabList` are used with `asChild`, and the triggers are written inline as direct children.
  return (
    <Tabs asChild>
      <View style={flat(styles.root, { flexDirection: 'column', backgroundColor: colors.background })}>
        {desktop ? (
          <TabList asChild>
            <View style={flat(styles.hiddenList)}>
              {ITEMS.map((item) => (
                <TabTrigger key={item.name} name={item.name} href={item.href} asChild>
                  <HiddenTrigger />
                </TabTrigger>
              ))}
            </View>
          </TabList>
        ) : null}
        {/* The tab screens have no native header, so keep them below the status bar / notch (0 on the web). The desktop shell keeps
            that room free around the whole navigator already. */}
        <View style={[styles.slot, { paddingTop: desktop ? 0 : insets.top }]}>
          <TabSlot style={styles.slotInner} />
        </View>
        {!desktop ? (
          <TabList asChild>
            <View
              style={flat(styles.bottomBar, {
                backgroundColor: colors.sidebar,
                paddingBottom: Math.max(insets.bottom, spacing.sm),
              })}>
              {left.map((item) => (
                <TabTrigger key={item.name} name={item.name} href={item.href} asChild>
                  <BottomButton item={item} />
                </TabTrigger>
              ))}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Add to diary"
                onPress={openAddSheet}
                style={styles.fabWrap}>
                <View style={[styles.fab, { backgroundColor: colors.primary, borderRadius: shape.circle(FAB_SIZE) }]}>
                  <Glyph name="plus" size={30} color={colors.onPrimary} strokeWidth={2.4} />
                </View>
              </Pressable>
              {right.map((item) => (
                <TabTrigger key={item.name} name={item.name} href={item.href} asChild>
                  <BottomButton item={item} {...(item.name === 'more' ? { badge: tabBadgeText(friendRequests), badgeLabel: friendRequestsLabel(friendRequests) } : {})} />
                </TabTrigger>
              ))}
            </View>
          </TabList>
        ) : null}
        {children}
      </View>
    </Tabs>
  );
}

/** What a desktop trigger renders: nothing. The trigger only has to exist so that the route is a screen of the tabs. */
function HiddenTrigger(): null {
  return null;
}

/** "2 friend requests" for a screen reader; the label of the tab itself stays "More". */
function friendRequestsLabel(count: number): string | undefined {
  return count > 0 ? `${count} friend ${count === 1 ? 'request' : 'requests'}` : undefined;
}

function BottomButton({
  item,
  isFocused,
  badge,
  badgeLabel,
  ...rest
}: TabTriggerSlotProps & { item: NavItem; badge?: string | undefined; badgeLabel?: string | undefined }) {
  const { colors, radius } = useTheme();
  const color = isFocused ? colors.primary : colors.onSidebarMuted;
  return (
    <Pressable
      {...(rest as PressableProps)}
      accessibilityRole="link"
      accessibilityLabel={item.label}
      {...(badgeLabel ? { accessibilityValue: { text: badgeLabel } } : {})}
      style={styles.bottomButton}>
      <View>
        <SymbolView name={item.symbol} size={22} tintColor={color} />
        {badge ? (
          <View accessible={false} style={[styles.badge, { backgroundColor: colors.danger, borderRadius: radius.pill }]}>
            <Text style={[styles.badgeText, { color: colors.onDanger }]}>{badge}</Text>
          </View>
        ) : null}
      </View>
      <Text style={[styles.bottomLabel, { color }]}>{item.label}</Text>
    </Pressable>
  );
}

/** The round "+" button in the middle of the phone tab bar (a rounded square in the boxy look). */
const FAB_SIZE = 58;

const styles = StyleSheet.create({
  root: { flex: 1 },
  slot: { flex: 1 },
  slotInner: { flex: 1 },
  hiddenList: { display: 'none' },
  bottomBar: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-around', paddingTop: spacing.sm },
  bottomButton: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: spacing.xs },
  bottomLabel: { fontSize: 11, fontWeight: '600' },
  badge: { position: 'absolute', top: -4, right: -10, minWidth: 16, height: 16, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: 10, fontWeight: '800' },
  fabWrap: { flex: 1, alignItems: 'center', marginTop: -22 },
  fab: {
    width: FAB_SIZE,
    height: FAB_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      web: { boxShadow: '0 4px 12px rgba(0,0,0,0.35)' } as object,
      default: { elevation: 6, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: { width: 0, height: 3 } },
    }),
  },
});
