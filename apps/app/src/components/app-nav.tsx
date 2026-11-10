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
  useWindowDimensions,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { WIDE_BREAKPOINT, palette, radius, spacing, useTheme } from '@/theme';

interface NavItem {
  name: string;
  href: '/' | '/diary' | '/foods' | '/more';
  label: string;
  symbol: SymbolViewProps['name'];
}

const ITEMS: NavItem[] = [
  { name: 'index', href: '/', label: 'Dashboard', symbol: { ios: 'chart.bar.fill', android: 'bar_chart', web: 'bar_chart' } },
  { name: 'diary', href: '/diary', label: 'Diary', symbol: { ios: 'book.fill', android: 'menu_book', web: 'menu_book' } },
  { name: 'foods', href: '/foods', label: 'Foods', symbol: { ios: 'fork.knife', android: 'restaurant', web: 'restaurant' } },
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
 * Responsive shell: left sidebar on wide screens (web/tablet, like Cronometer web),
 * bottom tab bar with a centre "+" button on phones.
 */
export function AppShell({ children }: { children?: ReactNode }) {
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_BREAKPOINT;
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const left = ITEMS.slice(0, 2);
  const right = ITEMS.slice(2);

  // IMPORTANT: expo-router/ui finds the <TabTrigger>s by walking the ELEMENT tree at render time
  // (Tabs > TabList > direct children). Triggers hidden inside a custom component (or inside an extra <View>
  // between TabList and the trigger) are never registered, and pressing them silently does nothing.
  // So `Tabs`/`TabList` are used with `asChild`, and the triggers are written inline as direct children.
  return (
    <Tabs asChild>
      <View style={flat(styles.root, { flexDirection: wide ? 'row' : 'column', backgroundColor: colors.background })}>
        {wide ? (
          <TabList asChild>
            <View style={flat(styles.sidebar, { backgroundColor: colors.sidebar })}>
              <Text style={[styles.brand, { color: colors.onSidebar }]}>Cal Track</Text>
              <Pressable
                accessibilityRole="button"
                onPress={openAddSheet}
                style={[styles.sidebarAdd, { backgroundColor: colors.primary }]}>
                <Text style={styles.sidebarAddLabel}>+  Add to diary</Text>
              </Pressable>
              {ITEMS.map((item) => (
                <TabTrigger key={item.name} name={item.name} href={item.href} asChild>
                  <SidebarButton item={item} />
                </TabTrigger>
              ))}
            </View>
          </TabList>
        ) : null}
        <View style={styles.slot}>
          <TabSlot style={styles.slotInner} />
        </View>
        {!wide ? (
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
                <View style={[styles.fab, { backgroundColor: palette.orange }]}>
                  <Text style={styles.fabPlus}>+</Text>
                </View>
              </Pressable>
              {right.map((item) => (
                <TabTrigger key={item.name} name={item.name} href={item.href} asChild>
                  <BottomButton item={item} />
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

function SidebarButton({ item, isFocused, ...rest }: TabTriggerSlotProps & { item: NavItem }) {
  const { colors } = useTheme();
  const color = isFocused ? colors.primary : colors.onSidebar;
  return (
    <Pressable
      {...(rest as PressableProps)}
      accessibilityRole="link"
      accessibilityLabel={item.label}
      style={({ pressed }) => [styles.sidebarButton, pressed && { opacity: 0.7 }]}>
      <SymbolView name={item.symbol} size={20} tintColor={color} />
      <Text style={[styles.sidebarLabel, { color }]}>{item.label}</Text>
    </Pressable>
  );
}

function BottomButton({ item, isFocused, ...rest }: TabTriggerSlotProps & { item: NavItem }) {
  const { colors } = useTheme();
  const color = isFocused ? colors.primary : colors.onSidebarMuted;
  return (
    <Pressable
      {...(rest as PressableProps)}
      accessibilityRole="link"
      accessibilityLabel={item.label}
      style={styles.bottomButton}>
      <SymbolView name={item.symbol} size={22} tintColor={color} />
      <Text style={[styles.bottomLabel, { color }]}>{item.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  slot: { flex: 1 },
  slotInner: { flex: 1 },
  sidebar: {
    width: 232,
    flexDirection: 'column',
    alignItems: 'stretch',
    justifyContent: 'flex-start',
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
    gap: spacing.xs,
  },
  brand: { fontSize: 22, fontWeight: '800', marginBottom: spacing.md },
  sidebarAdd: { borderRadius: radius.pill, paddingVertical: spacing.md, alignItems: 'center', marginBottom: spacing.md },
  sidebarAddLabel: { color: '#fff', fontWeight: '700', fontSize: 15 },
  sidebarButton: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md, paddingHorizontal: spacing.sm },
  sidebarLabel: { fontSize: 16, fontWeight: '600' },
  bottomBar: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-around', paddingTop: spacing.sm },
  bottomButton: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: spacing.xs },
  bottomLabel: { fontSize: 11, fontWeight: '600' },
  fabWrap: { flex: 1, alignItems: 'center', marginTop: -22 },
  fab: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      web: { boxShadow: '0 4px 12px rgba(0,0,0,0.35)' } as object,
      default: { elevation: 6, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: { width: 0, height: 3 } },
    }),
  },
  fabPlus: { color: '#fff', fontSize: 32, lineHeight: 36, fontWeight: '400' },
});
