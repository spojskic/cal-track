import { Children, useState, type ReactNode } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';

import { spacing } from '@/theme';

/** Tracks the width of a container: `<View onLayout={onLayout}>`. 0 until measured. */
export function useMeasuredWidth(): [number, (e: LayoutChangeEvent) => void] {
  const [width, setWidth] = useState(0);
  return [width, (e) => setWidth(Math.round(e.nativeEvent.layout.width))];
}

/**
 * One column on narrow containers, two equal columns once each column can be at least `minItemWidth` wide.
 * Decided from the measured width (not the window) so it stays right next to the desktop sidebar.
 *
 * The two columns are independent vertical stacks (a "masonry" layout): items are dealt out left, right, left, right ...
 * and each column simply stacks its own cards. A short card next to a tall one therefore never leaves a hole, which a
 * wrapping row layout does (every row is as tall as its tallest card).
 */
export function ResponsiveGrid({
  children,
  minItemWidth = 300,
  gap = spacing.lg,
}: {
  children: ReactNode;
  minItemWidth?: number;
  gap?: number;
}) {
  const [width, onLayout] = useMeasuredWidth();
  const items = Children.toArray(children);
  const twoCols = width > 0 && width >= minItemWidth * 2 + gap;

  if (!twoCols) {
    return (
      <View onLayout={onLayout} style={{ gap, width: '100%' }}>
        {items}
      </View>
    );
  }

  const left = items.filter((_, i) => i % 2 === 0);
  const right = items.filter((_, i) => i % 2 === 1);
  return (
    <View onLayout={onLayout} style={{ flexDirection: 'row', alignItems: 'flex-start', gap, width: '100%' }}>
      <View style={{ flex: 1, minWidth: 0, gap }}>{left}</View>
      <View style={{ flex: 1, minWidth: 0, gap }}>{right}</View>
    </View>
  );
}
