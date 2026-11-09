import { useRef, useState, type ReactNode } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
} from 'react-native';

import { EnergySummary, type EnergySummaryProps } from '@/components/charts/EnergySummary';
import { HighlightRings, type HighlightRingItem } from '@/components/charts/HighlightRings';
import { MacroBar } from '@/components/charts/MacroBar';
import { AppText } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

import type { MacroRow } from './targets-view';

export interface PagerPage {
  key: string;
  label: string;
  content: ReactNode;
}

/** Horizontal paging container with page dots (swipe on touch devices, tap the dots anywhere). */
export function Pager({ pages }: { pages: PagerPage[] }) {
  const { colors } = useTheme();
  const scroller = useRef<ScrollViewInstance>(null);
  const [width, setWidth] = useState(0);
  const [index, setIndex] = useState(0);

  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width));
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (width <= 0) return;
    const next = Math.round(e.nativeEvent.contentOffset.x / width);
    setIndex((cur) => (cur === next ? cur : Math.max(0, Math.min(pages.length - 1, next))));
  };
  const goTo = (i: number) => {
    setIndex(i);
    scroller.current?.scrollTo({ x: i * width, animated: true });
  };

  const current = pages[index];

  return (
    <View style={styles.wrap}>
      <View onLayout={onLayout}>
        <ScrollView
          ref={scroller}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onScroll={onScroll}
          scrollEventThrottle={16}
          accessibilityLabel="Targets, swipe for more"
          style={styles.scroller}>
          {pages.map((page) => (
            <View key={page.key} style={{ width: width || '100%' }}>
              {page.content}
            </View>
          ))}
        </ScrollView>
      </View>
      {pages.length > 1 ? (
        <View style={styles.dots} accessibilityRole="tablist">
          {pages.map((page, i) => (
            <Pressable
              key={page.key}
              accessibilityRole="tab"
              accessibilityLabel={`${page.label}${current?.key === page.key ? ', current page' : ''}`}
              accessibilityState={{ selected: i === index }}
              hitSlop={8}
              onPress={() => goTo(i)}
              style={[
                styles.dot,
                { backgroundColor: i === index ? colors.primary : colors.track, width: i === index ? 18 : 7 },
              ]}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Macro bars (Energy, Protein, Net Carbs, Fat) */
export function MacroBars({ rows }: { rows: MacroRow[] }) {
  return (
    <View style={styles.bars}>
      {rows.map((row) => (
        <MacroBar
          key={row.key}
          label={row.label}
          value={row.value}
          target={row.target}
          netValue={row.netValue}
          unit={row.unit}
          color={row.color}
          decimals={row.decimals}
          overIsBad={row.overIsBad}
        />
      ))}
    </View>
  );
}

/** Phone targets card content: macro bars / energy rings / highlighted nutrients, as swipeable pages. */
export function TargetsPager({
  rows,
  energy,
  highlights,
}: {
  rows: MacroRow[];
  energy: EnergySummaryProps;
  highlights: HighlightRingItem[];
}) {
  const pages: PagerPage[] = [
    { key: 'macros', label: 'Macros', content: <MacroBars rows={rows} /> },
    { key: 'energy', label: 'Energy', content: <EnergySummary {...energy} compact animated={false} /> },
  ];
  if (highlights.length > 0) {
    pages.push({
      key: 'nutrients',
      label: 'Highlighted nutrients',
      content: (
        <View style={styles.highlights}>
          <AppText variant="label" muted>
            Highlighted nutrients
          </AppText>
          <HighlightRings items={highlights.slice(0, 8)} size={52} />
        </View>
      ),
    });
  }
  return <Pager pages={pages} />;
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  scroller: { flexGrow: 0 },
  bars: { gap: spacing.md, paddingRight: 1 },
  highlights: { gap: spacing.sm },
  dots: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6 },
  dot: { height: 7, borderRadius: 4 },
});
