import { useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { useTheme } from '@/theme';

/** Minimal line chart for trends (weight). Fills the available width. Pure presentational. */
export function Sparkline({
  values,
  height = 72,
  color,
  accessibilityLabel,
}: {
  values: number[];
  height?: number;
  color?: string;
  accessibilityLabel?: string;
}) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const stroke = color ?? colors.primary;
  const pad = 6;

  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width));

  let line = '';
  let area = '';
  let last: { x: number; y: number } | undefined;
  if (width > 0 && values.length > 0) {
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const pts = values.map((v, i) => ({
      x: values.length === 1 ? width / 2 : pad + (i / (values.length - 1)) * (width - pad * 2),
      y: values.length === 1 || max === min ? height / 2 : pad + (1 - (v - min) / span) * (height - pad * 2),
    }));
    line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    const first = pts[0];
    last = pts[pts.length - 1];
    if (first && last && pts.length > 1) area = `${line} L${last.x.toFixed(1)} ${height} L${first.x.toFixed(1)} ${height} Z`;
  }

  return (
    <View
      onLayout={onLayout}
      style={{ height }}
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel ?? 'Trend chart'}>
      {width > 0 ? (
        <Svg width={width} height={height}>
          {area ? <Path d={area} fill={stroke} opacity={0.12} /> : null}
          {values.length > 1 ? (
            <Path d={line} stroke={stroke} strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          ) : null}
          {last ? <Circle cx={last.x} cy={last.y} r={4} fill={stroke} /> : null}
        </Svg>
      ) : null}
    </View>
  );
}
