import { useColorScheme } from 'react-native';

import { darkColors, lightColors, type ThemeColors } from './colors';

export * from './colors';

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 } as const;

/** Width (px) from which the web/tablet layout switches from bottom tabs to a left sidebar. */
export const WIDE_BREAKPOINT = 900;
/** Max content width for readable pages on large screens. */
export const MAX_CONTENT_WIDTH = 880;

export function useTheme(): { colors: ThemeColors; isDark: boolean } {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  return { colors: isDark ? darkColors : lightColors, isDark };
}
