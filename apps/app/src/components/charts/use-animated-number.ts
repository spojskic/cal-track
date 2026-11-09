import { useEffect, useState } from 'react';
import { Animated, Easing } from 'react-native';

/**
 * Smoothly tweens to `target` (JS driven, so it works for SVG props on every platform).
 * With `enabled=false` it returns `target` unchanged.
 */
export function useAnimatedNumber(target: number, enabled = true, duration = 600): number {
  const safe = Number.isFinite(target) ? target : 0;
  const [anim] = useState(() => new Animated.Value(0));
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const id = anim.addListener(({ value: v }) => setValue(v));
    Animated.timing(anim, {
      toValue: safe,
      duration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
    return () => {
      anim.removeListener(id);
      anim.stopAnimation();
    };
  }, [anim, safe, enabled, duration]);

  return enabled ? value : safe;
}
