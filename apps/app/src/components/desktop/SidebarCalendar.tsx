// The collapsible calendar of the sidebar: a compact month grid (Monday first) with the month arrows, a "Today" chip, today ringed and
// the diary date that is open filled. Pressing a day makes it the diary date and opens the diary. The date maths is in month-grid.ts.
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Glyph } from '@/components/Glyph';
import { todayISO, useSelectedDate } from '@/state/selected-date';
import { useTheme } from '@/theme';

import {
  WEEKDAY_INITIALS,
  buildMonthGrid,
  dayLabel,
  monthOf,
  monthTitle,
  shiftMonth,
  type MonthCell,
  type MonthRef,
} from './month-grid';
import { GroupHeader, SIDEBAR_PADDING, useRowFill, webAria } from './sidebar-parts';
import { useSectionCollapsed, useSidebarStore } from './sidebar-store';

const CELL_HEIGHT = 24;
const ARROW = 22;
const FALLBACK_MONTH: MonthRef = { year: 2026, month: 1 };

export function SidebarCalendar({ onPickDay }: { onPickDay: (iso: string) => void }) {
  const collapsed = useSectionCollapsed('calendar');
  const toggle = useSidebarStore((s) => s.toggle);
  return (
    <View>
      <GroupHeader label="Calendar" collapsed={collapsed} onToggle={() => toggle('calendar')} />
      {collapsed ? null : <MonthView onPickDay={onPickDay} />}
    </View>
  );
}

function MonthView({ onPickDay }: { onPickDay: (iso: string) => void }) {
  const { colors } = useTheme();
  const selected = useSelectedDate((s) => s.date);
  const today = todayISO();
  const [view, setView] = useState<MonthRef>(() => monthOf(selected, monthOf(today, FALLBACK_MONTH)));

  // The month on screen follows the diary date when that moves (the arrows of the diary, a day picked here, "Today"). Adjusted while
  // rendering, as React recommends for state that derives from a changed value: no extra render with the old month.
  const [followed, setFollowed] = useState(selected);
  if (followed !== selected) {
    setFollowed(selected);
    setView(monthOf(selected, view));
  }

  const weeks = useMemo(() => buildMonthGrid(view, { today, selected }), [view, today, selected]);

  return (
    <View style={styles.month}>
      <View style={styles.monthBar}>
        <Text numberOfLines={1} style={[styles.monthTitle, { color: colors.onSidebar }]}>
          {monthTitle(view)}
        </Text>
        <TodayChip
          onPress={() => {
            setView(monthOf(today, view));
            onPickDay(today);
          }}
        />
        <MonthArrow glyph="chevron-left" label="Previous month" onPress={() => setView((v) => shiftMonth(v, -1))} />
        <MonthArrow glyph="chevron-right" label="Next month" onPress={() => setView((v) => shiftMonth(v, 1))} />
      </View>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.week}>
        {WEEKDAY_INITIALS.map((initial, i) => (
          <Text key={i} style={[styles.weekday, { color: colors.onSidebarMuted }]}>
            {initial}
          </Text>
        ))}
      </View>
      {weeks.map((week, w) => (
        <View key={w} style={styles.week}>
          {week.map((cell) => (
            <DayCell key={cell.iso} cell={cell} onPress={() => onPickDay(cell.iso)} />
          ))}
        </View>
      ))}
    </View>
  );
}

function DayCell({ cell, onPress }: { cell: MonthCell; onPress: () => void }) {
  const { colors, radius } = useTheme();
  const fill = useRowFill();
  const [hovered, setHovered] = useState(false);
  const color = cell.isSelected ? colors.onPrimary : cell.inMonth ? colors.onSidebar : colors.onSidebarMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={dayLabel(cell.iso)}
      {...webAria({ 'aria-pressed': cell.isSelected ? true : undefined, 'aria-current': cell.isToday ? 'date' : undefined })}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={styles.dayWrap}>
      <View
        style={[
          styles.day,
          { borderRadius: radius.sm },
          cell.isSelected
            ? { backgroundColor: colors.primary }
            : hovered
              ? { backgroundColor: fill.hover }
              : null,
          cell.isToday ? { borderColor: colors.primary, borderWidth: 1 } : null,
        ]}>
        <Text style={[styles.dayLabel, { color, fontWeight: cell.isToday || cell.isSelected ? '700' : '400', opacity: cell.inMonth ? 1 : 0.55 }]}>
          {cell.day}
        </Text>
      </View>
    </Pressable>
  );
}

function TodayChip({ onPress }: { onPress: () => void }) {
  const { colors, radius } = useTheme();
  const fill = useRowFill();
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Jump to today"
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[styles.chip, { borderRadius: radius.sm, backgroundColor: hovered ? fill.press : fill.hover }]}>
      <Text style={[styles.chipLabel, { color: colors.onSidebar }]}>Today</Text>
    </Pressable>
  );
}

function MonthArrow({ glyph, label, onPress }: { glyph: 'chevron-left' | 'chevron-right'; label: string; onPress: () => void }) {
  const { colors, radius } = useTheme();
  const fill = useRowFill();
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[styles.arrow, { borderRadius: radius.sm, backgroundColor: hovered ? fill.hover : 'transparent' }]}>
      <Glyph name={glyph} size={14} color={colors.onSidebar} strokeWidth={2.4} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  month: { paddingHorizontal: SIDEBAR_PADDING, paddingTop: 4, paddingBottom: 6, gap: 2 },
  monthBar: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: ARROW, marginBottom: 4 },
  monthTitle: { flex: 1, fontSize: 12.5, fontWeight: '600', minWidth: 0 },
  chip: { height: ARROW, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center' },
  chipLabel: { fontSize: 11.5, fontWeight: '600' },
  arrow: { width: ARROW, height: ARROW, alignItems: 'center', justifyContent: 'center' },
  week: { flexDirection: 'row' },
  weekday: { flex: 1, textAlign: 'center', fontSize: 10.5, fontWeight: '600', height: 18, lineHeight: 18 },
  dayWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', height: CELL_HEIGHT },
  day: { width: 26, height: CELL_HEIGHT - 2, alignItems: 'center', justifyContent: 'center' },
  dayLabel: { fontSize: 11.5 },
});
