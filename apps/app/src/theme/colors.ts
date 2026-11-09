/** Brand/semantic palette. Inspired by Cronometer's look (orange accent, green/teal/purple macros). */
export const palette = {
  orange: '#EF7B54',
  green: '#85D49C',
  teal: '#6ECBD9',
  purple: '#B57FC9',
  red: '#D64545',
  amber: '#F2B84B',
  deepTeal: '#235A5B',
} as const;

export interface ThemeColors {
  background: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  textMuted: string;
  primary: string;
  onPrimary: string;
  accent: string;
  sidebar: string;
  onSidebar: string;
  onSidebarMuted: string;
  energy: string;
  protein: string;
  carbs: string;
  fat: string;
  danger: string;
  warning: string;
  success: string;
  track: string;
}

export const lightColors: ThemeColors = {
  background: '#FBFAF5',
  surface: '#FFFFFF',
  surfaceAlt: '#EEF0F7',
  border: '#E2E4EC',
  text: '#232A3B',
  textMuted: '#6B7285',
  primary: palette.orange,
  onPrimary: '#FFFFFF',
  accent: palette.deepTeal,
  sidebar: '#262A3B',
  onSidebar: '#F2F3F8',
  onSidebarMuted: '#9AA0B5',
  energy: palette.orange,
  protein: palette.green,
  carbs: palette.teal,
  fat: palette.purple,
  danger: palette.red,
  warning: palette.amber,
  success: '#4CAF7A',
  track: '#E9EAF1',
};

export const darkColors: ThemeColors = {
  background: '#12141F',
  surface: '#262A3B',
  surfaceAlt: '#1D2030',
  border: '#363B52',
  text: '#F2F3F8',
  textMuted: '#9AA0B5',
  primary: palette.orange,
  onPrimary: '#FFFFFF',
  accent: '#4FB3B5',
  sidebar: '#1D2030',
  onSidebar: '#F2F3F8',
  onSidebarMuted: '#9AA0B5',
  energy: palette.orange,
  protein: palette.green,
  carbs: palette.teal,
  fat: palette.purple,
  danger: '#F06A6A',
  warning: palette.amber,
  success: '#5FD39A',
  track: '#363B52',
};
