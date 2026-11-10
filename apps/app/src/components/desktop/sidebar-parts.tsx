// The small building blocks the sidebar and its calendar share: the collapsible group heading and the colours of a row on the sidebar
// background. Corners come from `useTheme().radius` (tools/ui-smoke/src/shape-guard.test.ts), colours from `useTheme().colors`.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Glyph } from '@/components/Glyph';
import { useTheme, withAlpha } from '@/theme';

/** Space between the sidebar's edge and its content. */
export const SIDEBAR_PADDING = 10;

/**
 * ARIA attributes that React Native's types do not list (`aria-current`, `aria-pressed`). react-native-web passes them to the DOM;
 * native ignores them. An `undefined` value leaves the attribute out.
 */
export function webAria(attrs: Record<string, string | boolean | undefined>): object {
  return attrs;
}

/** The fill behind a row: the page that is open, the pointer over it, or nothing. Alpha of the sidebar's own text colour, so it follows the palette. */
export function useRowFill(): { active: string; hover: string; press: string } {
  const { colors } = useTheme();
  return {
    active: withAlpha(colors.onSidebar, 0.14),
    hover: withAlpha(colors.onSidebar, 0.07),
    press: withAlpha(colors.onSidebar, 0.1),
  };
}

/**
 * The small muted heading of a group, with a chevron that collapses it (pointing down while the group is open, right while it is
 * closed). The whole heading is one button named exactly like the group; `expanded` tells screen readers (and the browser smoke)
 * whether its rows are shown.
 */
export function GroupHeader({ label, collapsed, onToggle }: { label: string; collapsed: boolean; onToggle: () => void }) {
  const { colors, radius } = useTheme();
  const fill = useRowFill();
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded: !collapsed }}
      // react-native-web 0.21 does not turn accessibilityState into aria-* attributes, so say it for the DOM too
      {...webAria({ 'aria-expanded': !collapsed })}
      onPress={onToggle}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[styles.header, { borderRadius: radius.sm, backgroundColor: hovered ? fill.hover : 'transparent' }]}>
      <Text numberOfLines={1} style={[styles.headerLabel, { color: colors.onSidebarMuted }]}>
        {label}
      </Text>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Glyph name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} color={colors.onSidebarMuted} strokeWidth={2.6} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: {
    height: 26,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SIDEBAR_PADDING,
  },
  headerLabel: { flexShrink: 1, fontSize: 11.5, fontWeight: '600', letterSpacing: 0.2 },
});
