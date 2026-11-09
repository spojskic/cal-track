import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { AppText } from '@/components/ui';
import { useTheme } from '@/theme';

import { useAnimatedNumber } from './use-animated-number';

export interface ProgressRingProps {
  /** Fraction of the goal: 0..1 fills the ring, > 1 means over (ring stays full, `overColor` is used). */
  value: number;
  size?: number;
  strokeWidth?: number;
  color?: string;
  overColor?: string;
  trackColor?: string;
  /** Main text in the middle. */
  label?: string;
  /** Smaller text under the label. */
  sublabel?: string;
  animated?: boolean;
  /** Replaces label/sublabel. */
  children?: ReactNode;
  accessibilityLabel?: string;
}

/** SVG donut with a centre label. Pure presentational. */
export function ProgressRing({
  value,
  size = 96,
  strokeWidth = Math.max(4, Math.round(size * 0.1)),
  color,
  overColor,
  trackColor,
  label,
  sublabel,
  animated = false,
  children,
  accessibilityLabel,
}: ProgressRingProps) {
  const { colors } = useTheme();
  const raw = Number.isFinite(value) ? Math.max(0, value) : 0;
  const shown = useAnimatedNumber(Math.min(raw, 1), animated);
  const r = (size - strokeWidth) / 2;
  const c = 2 * Math.PI * r;
  const stroke = raw > 1 && overColor ? overColor : (color ?? colors.primary);
  const labelSize = Math.max(11, Math.round(size * 0.2));
  const subSize = Math.max(9, Math.round(size * 0.125));
  const text = accessibilityLabel ?? [label, sublabel].filter(Boolean).join(' ');

  return (
    <View
      style={{ width: size, height: size }}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={text}
      accessibilityValue={{ min: 0, max: 100, now: Math.min(100, Math.round(raw * 100)) }}>
      <Svg width={size} height={size} style={styles.rotated}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={trackColor ?? colors.track} strokeWidth={strokeWidth} fill="none" />
        {shown > 0.002 ? (
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={stroke}
            strokeWidth={strokeWidth}
            fill="none"
            strokeDasharray={`${c} ${c}`}
            strokeDashoffset={c * (1 - shown)}
            strokeLinecap="round"
          />
        ) : null}
      </Svg>
      <View style={[StyleSheet.absoluteFill, styles.center, styles.noTouch]}>
        {children ?? (
          <>
            {label ? (
              <AppText
                numberOfLines={1}
                adjustsFontSizeToFit
                style={{ fontSize: labelSize, fontWeight: '800', maxWidth: size - strokeWidth * 2 - 4, textAlign: 'center' }}>
                {label}
              </AppText>
            ) : null}
            {sublabel ? (
              <AppText numberOfLines={1} muted style={{ fontSize: subSize, maxWidth: size - strokeWidth * 2 - 4, textAlign: 'center' }}>
                {sublabel}
              </AppText>
            ) : null}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  rotated: { transform: [{ rotate: '-90deg' }] },
  center: { alignItems: 'center', justifyContent: 'center' },
  noTouch: { pointerEvents: 'none' },
});
