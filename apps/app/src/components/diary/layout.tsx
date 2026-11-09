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
  const itemWidth = twoCols ? Math.floor((width - gap) / 2) : undefined;

  return (
    <View onLayout={onLayout} style={{ flexDirection: 'row', flexWrap: 'wrap', gap, width: '100%' }}>
      {items.map((child, i) => (
        <View key={i} style={itemWidth ? { width: itemWidth } : { width: '100%' }}>
          {child}
        </View>
      ))}
    </View>
  );
}
