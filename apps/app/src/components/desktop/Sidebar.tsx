// The desktop sidebar: brand and "Add to diary" on top, the groups of rows in the middle (Daily, Training, Coach, Profile, Connections,
// App, then the calendar; each group collapses), the signed-in account and Sign out pinned at the bottom. It is rendered once, by
// DesktopFrame, above the navigator: it does not remount when the page changes. What it lists is in sidebar-model.ts.
import { router, usePathname, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle } from 'react-native-svg';

import { useAiBootstrap } from '@/ai/use-ai-bootstrap';
import { useAiGate } from '@/ai/use-ai-gate';
import { Glyph } from '@/components/Glyph';
import { useAuth } from '@/lib/auth';
import { useSelectedDate } from '@/state/selected-date';
import { useTheme, withAlpha } from '@/theme';
import { SIDEBAR_WIDTH } from '@/theme/desktop';

import { sidebarNavigation } from './shell-routes';
import { SidebarCalendar } from './SidebarCalendar';
import { GroupHeader, SIDEBAR_PADDING, useRowFill, webAria } from './sidebar-parts';
import { buildSidebarGroups, normalizePath, resolveActiveRowId, rowAccessibleName, type SidebarGroup, type SidebarRow } from './sidebar-model';
import { useSectionCollapsed, useSidebarStore } from './sidebar-store';

/** Opens a page from the sidebar the way `sidebarNavigation` says (see shell-routes.ts). Typed routes are generated while the dev server runs, so a path is cast. */
function goTo(currentPathname: string, href: string): void {
  const mode = sidebarNavigation(currentPathname, href);
  if (mode === 'none') return;
  const target = href as unknown as Href;
  if (mode === 'replace') router.replace(target);
  else if (mode === 'dismissTo') router.dismissTo(target);
  else router.navigate(target);
}

export function Sidebar() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  // The Coach row and the AI row's status depend on the AI gate. The (app) layout loads it, but a window opened straight on a page
  // outside the tabs (a reload on /workouts, a link to /settings/display) never mounts that layout. Idempotent.
  useAiBootstrap();
  const ai = useAiGate();
  const groups = useMemo(() => buildSidebarGroups({ aiEnabled: ai.enabled }), [ai.enabled]);
  const activeRowId = resolveActiveRowId(groups, pathname);

  return (
    <View style={[styles.root, { backgroundColor: colors.sidebar, paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.top}>
        <Brand />
        <AddToDiaryButton pathname={pathname} />
      </View>
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false}>
        {groups.map((group) => (
          <Group key={group.id} group={group} activeRowId={activeRowId} onOpen={(href) => goTo(pathname, href)} />
        ))}
        <SidebarCalendar
          onPickDay={(iso) => {
            useSelectedDate.getState().setDate(iso);
            goTo(pathname, '/diary');
          }}
        />
      </ScrollView>
      <AccountFooter />
    </View>
  );
}

function Brand() {
  const { colors } = useTheme();
  return (
    <View style={styles.brand}>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Svg width={20} height={20} viewBox="0 0 20 20">
          <Circle cx={10} cy={10} r={7.5} stroke={withAlpha(colors.onSidebar, 0.22)} strokeWidth={2.5} fill="none" />
          <Circle
            cx={10}
            cy={10}
            r={7.5}
            stroke={colors.primary}
            strokeWidth={2.5}
            fill="none"
            strokeDasharray="35 12"
            strokeLinecap="round"
            transform="rotate(-90 10 10)"
          />
        </Svg>
      </View>
      <Text numberOfLines={1} style={[styles.brandText, { color: colors.onSidebar }]}>
        Cal Track
      </Text>
    </View>
  );
}

function AddToDiaryButton({ pathname }: { pathname: string }) {
  const { colors, radius } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Add to diary"
      // The add sheet is a screen on top of the page: do not stack a second one when it is open already.
      onPress={() => {
        if (normalizePath(pathname) !== '/add') router.push('/add');
      }}
      style={({ pressed }) => [styles.add, { backgroundColor: colors.primary, borderRadius: radius.md, opacity: pressed ? 0.85 : 1 }]}>
      <Glyph name="plus" size={14} color={colors.onPrimary} strokeWidth={2.6} />
      <Text style={[styles.addLabel, { color: colors.onPrimary }]}>Add to diary</Text>
    </Pressable>
  );
}

function Group({ group, activeRowId, onOpen }: { group: SidebarGroup; activeRowId: string | null; onOpen: (href: string) => void }) {
  const collapsed = useSectionCollapsed(group.id);
  const toggle = useSidebarStore((s) => s.toggle);
  return (
    <View style={styles.group}>
      <GroupHeader label={group.label} collapsed={collapsed} onToggle={() => toggle(group.id)} />
      {collapsed
        ? null
        : group.rows.map((row) => <NavItem key={row.id} row={row} active={row.id === activeRowId} onPress={() => onOpen(row.href)} />)}
    </View>
  );
}

/** One row: icon, label and (for the AI row) its On / Off status. One accessible link, named like the row; the icon is decoration. */
function NavItem({ row, active, onPress }: { row: SidebarRow; active: boolean; onPress: () => void }) {
  const { colors, radius } = useTheme();
  const fill = useRowFill();
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={rowAccessibleName(row)}
      {...webAria({ 'aria-current': active ? 'page' : undefined })}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => [
        styles.row,
        { borderRadius: radius.sm, backgroundColor: active ? fill.active : pressed ? fill.press : hovered ? fill.hover : 'transparent' },
      ]}>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.icon}>
        <SymbolView name={row.symbol} size={16} tintColor={active ? colors.primary : colors.onSidebarMuted} />
      </View>
      <Text numberOfLines={1} style={[styles.label, { color: colors.onSidebar, fontWeight: active ? '700' : '500' }]}>
        {row.label}
      </Text>
      {row.badge ? <Text style={[styles.badge, { color: colors.onSidebarMuted }]}>{row.badge}</Text> : null}
    </Pressable>
  );
}

/** Pinned under the list: who is signed in, and Sign out (what the Account section of the More screen does on a phone). */
function AccountFooter() {
  const { colors, radius } = useTheme();
  const { session, signOut } = useAuth();
  const email = session?.user.email ?? '';
  return (
    <View style={[styles.footer, { borderTopColor: withAlpha(colors.onSidebar, 0.12) }]}>
      <Text numberOfLines={1} accessibilityLabel={`Signed in as ${email || 'unknown'}`} style={[styles.email, { color: colors.onSidebarMuted }]}>
        {email}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Sign out"
        onPress={signOut}
        style={({ pressed }) => [
          styles.signOut,
          { borderRadius: radius.md, borderColor: withAlpha(colors.onSidebar, 0.28), opacity: pressed ? 0.7 : 1 },
        ]}>
        <Text style={[styles.signOutLabel, { color: colors.onSidebar }]}>Sign out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { width: SIDEBAR_WIDTH, flexDirection: 'column' },
  top: { paddingHorizontal: 8, paddingTop: 12, paddingBottom: 8, gap: 12 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: SIDEBAR_PADDING, height: 24 },
  brandText: { flexShrink: 1, fontSize: 15, fontWeight: '700', letterSpacing: 0.1 },
  add: { height: 32, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  addLabel: { fontSize: 13, fontWeight: '700' },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 8, paddingTop: 4, paddingBottom: 8, gap: 6 },
  group: { gap: 1 },
  row: { height: 28, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: SIDEBAR_PADDING },
  icon: { width: 16, height: 16, alignItems: 'center', justifyContent: 'center' },
  label: { flex: 1, minWidth: 0, fontSize: 13 },
  badge: { fontSize: 11.5, fontWeight: '600' },
  footer: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 10, gap: 8, borderTopWidth: StyleSheet.hairlineWidth },
  email: { fontSize: 12 },
  signOut: { height: 28, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  signOutLabel: { fontSize: 12.5, fontWeight: '600' },
});
