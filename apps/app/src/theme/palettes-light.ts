// Pure (no React Native imports): the light palettes. Colours are the published ones of each theme; where a value had to be
// adjusted to reach the contrast floors of theme.test.ts the line says `nudged`. Surfaces marked `derived` are a lighter tint of
// the page colour for themes that publish nothing lighter than their background.
import { lightColors, type PaletteDef } from './colors';
import { defineColors } from './define-colors';

export const LIGHT_PALETTES: readonly PaletteDef[] = [
  {
    // kanagawa.nvim "lotus"
    id: 'kanagawa-lotus',
    name: 'Kanagawa Lotus',
    appearance: 'light',
    colors: defineColors(
      {
        background: '#F2ECBC', // lotusWhite3
        surface: '#F8F4D6', // derived
        surfaceAlt: '#E5DDB0', // lotusWhite2
        border: '#D5CEA3', // lotusWhite0
        text: '#43436C', // lotusInk2
        textMuted: '#6D6A5D', // nudged from #716E61 (lotusGray2)
        primary: '#4D699B', // lotusBlue4
        accent: '#597B75', // lotusAqua
        sidebar: '#DCD5AC', // lotusWhite1
        onSidebar: '#43436C',
        onSidebarMuted: '#5E5B50', // textMuted, darkened to 4.5 : 1 on the sidebar
        energy: '#CC6D00', // lotusOrange
        protein: '#6F894E', // lotusGreen
        carbs: '#4E8CA2', // lotusTeal1
        fat: '#624C83', // lotusViolet4
        danger: '#C84053', // lotusRed
        warning: '#C37300', // nudged from #E98A00 (lotusOrange2)
        success: '#6F894E',
        track: '#E4D794', // lotusWhite5
      },
      { dark: '#16161D', light: '#F8F4D6' },
    ),
  },
  {
    // Catppuccin Latte
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    appearance: 'light',
    colors: defineColors(
      {
        background: '#EFF1F5', // base
        surface: '#F7F8FA', // derived
        surfaceAlt: '#E6E9EF', // mantle
        border: '#CCD0DA', // surface0
        text: '#4C4F69',
        textMuted: '#6A6D82', // nudged from #6C6F85 (subtext0)
        primary: '#1E66F5', // blue
        accent: '#179299', // teal
        sidebar: '#DCE0E8', // crust
        onSidebar: '#4C4F69',
        onSidebarMuted: '#606275', // textMuted, darkened to 4.5 : 1 on the sidebar
        energy: '#FE640B', // peach
        protein: '#40A02B', // green
        carbs: '#209FB5', // sapphire
        fat: '#8839EF', // mauve
        danger: '#D20F39', // red
        warning: '#C27B19', // nudged from #DF8E1D (yellow)
        success: '#3F9E2A', // nudged from #40A02B
        track: '#CCD0DA',
      },
      { dark: '#11111B', light: '#EFF1F5' },
    ),
  },
  {
    // Solarized Light
    id: 'solarized-light',
    name: 'Solarized Light',
    appearance: 'light',
    colors: defineColors(
      {
        background: '#FDF6E3', // base3
        surface: '#FFFBF0', // derived
        surfaceAlt: '#EEE8D5', // base2
        border: '#DDD6C1', // derived (between base2 and base1)
        text: '#073642', // base02
        textMuted: '#586E75', // base01
        primary: '#268BD2', // blue
        accent: '#2AA198', // cyan
        sidebar: '#EEE8D5',
        onSidebar: '#073642',
        onSidebarMuted: '#566B72', // textMuted, darkened to 4.5 : 1 on the sidebar
        energy: '#CB4B16', // orange
        protein: '#859900', // green
        carbs: '#2AA198', // cyan
        fat: '#6C71C4', // violet
        danger: '#DC322F', // red
        warning: '#B28700', // nudged from #B58900 (yellow)
        success: '#839600', // nudged from #859900
        track: '#DDD6C1',
      },
      { dark: '#00212B', light: '#FDF6E3' },
    ),
  },
  {
    // Gruvbox Light (medium)
    id: 'gruvbox-light',
    name: 'Gruvbox Light',
    appearance: 'light',
    colors: defineColors(
      {
        background: '#FBF1C7', // bg0
        surface: '#F9F5D7', // bg0_h
        surfaceAlt: '#EBDBB2', // bg1
        border: '#D5C4A1', // bg2
        text: '#3C3836', // fg1
        textMuted: '#665C54', // fg3
        primary: '#076678', // faded blue
        accent: '#427B58', // faded aqua
        sidebar: '#EBDBB2',
        onSidebar: '#3C3836',
        onSidebarMuted: '#665C54', // = textMuted
        energy: '#AF3A03', // faded orange
        protein: '#79740E', // faded green
        carbs: '#458588', // neutral blue
        fat: '#8F3F71', // faded purple
        danger: '#9D0006', // faded red
        warning: '#B57614', // faded yellow
        success: '#79740E',
        track: '#D5C4A1',
      },
      { dark: '#282828', light: '#FBF1C7' },
    ),
  },
  {
    // GitHub Primer, light default
    id: 'github-light',
    name: 'GitHub Light',
    appearance: 'light',
    colors: defineColors(
      {
        background: '#F6F8FA', // canvas subtle
        surface: '#FFFFFF', // canvas default
        surfaceAlt: '#EAEEF2',
        border: '#D0D7DE',
        text: '#1F2328',
        textMuted: '#656D76',
        primary: '#0969DA', // accent fg
        accent: '#8250DF', // done fg
        sidebar: '#EAEEF2',
        onSidebar: '#1F2328',
        onSidebarMuted: '#646C75', // textMuted, darkened to 4.5 : 1 on the sidebar
        energy: '#BC4C00', // severe fg
        protein: '#1A7F37', // success fg
        carbs: '#1B7C83', // teal
        fat: '#8250DF',
        danger: '#D1242F', // danger fg
        warning: '#9A6700', // attention fg
        success: '#1A7F37',
        track: '#D8DEE4',
      },
      { dark: '#1F2328', light: '#FFFFFF' },
    ),
  },
  {
    // Rosé Pine Dawn
    id: 'rose-pine-dawn',
    name: 'Rosé Pine Dawn',
    appearance: 'light',
    colors: defineColors(
      {
        background: '#FAF4ED', // base
        surface: '#FFFAF3', // surface
        surfaceAlt: '#F2E9E1', // overlay
        border: '#DFDAD9', // highlight med
        text: '#534E73', // nudged from #575279
        textMuted: '#716D8C', // nudged from #797593 (subtle)
        primary: '#286983', // pine
        accent: '#907AA9', // iris
        sidebar: '#F2E9E1',
        onSidebar: '#575279',
        onSidebarMuted: '#6A6683', // textMuted, darkened to 4.5 : 1 on the sidebar
        energy: '#D7827E', // rose
        protein: '#56949F', // foam
        carbs: '#EA9D34', // gold
        fat: '#907AA9', // iris
        danger: '#B4637A', // love
        warning: '#C77C15', // nudged from #EA9D34 (gold)
        success: '#56949F',
        track: '#DFDAD9',
      },
      { dark: '#191724', light: '#FFFAF3' },
    ),
  },
  {
    // tokyonight.nvim "day"
    id: 'tokyo-night-day',
    name: 'Tokyo Night Day',
    appearance: 'light',
    colors: defineColors(
      {
        background: '#E1E2E7',
        surface: '#EAEBEF', // derived
        surfaceAlt: '#D0D5E3', // bg_dark
        border: '#C4C8DA', // bg_highlight
        text: '#343B58',
        textMuted: '#5061A0', // nudged from #6172B0 (fg_dark)
        primary: '#1F70E0', // nudged from #2E7DE9 (blue): 3 : 1 on the sidebar, and white labels reach 4.5 : 1
        accent: '#9854F1', // magenta
        sidebar: '#D0D5E3',
        onSidebar: '#343B58',
        onSidebarMuted: '#495992', // textMuted, darkened to 4.5 : 1 on the sidebar
        energy: '#B15C00', // orange
        protein: '#587539', // green
        carbs: '#007197', // cyan
        fat: '#7847BD', // purple
        danger: '#F52A65', // red
        warning: '#8C6C3E', // yellow
        success: '#587539',
        track: '#C4C8DA',
      },
      { dark: '#15161E', light: '#FFFFFF' },
    ),
  },
  {
    // Atom One Light
    id: 'one-light',
    name: 'One Light',
    appearance: 'light',
    colors: defineColors(
      {
        background: '#FAFAFA',
        surface: '#FFFFFF',
        surfaceAlt: '#F0F0F1',
        border: '#DBDBDC',
        text: '#383A42',
        textMuted: '#696C77', // mono-2
        primary: '#376FE6', // nudged from #4078F2 (hue-2) so white button labels reach 4.5 : 1
        accent: '#A626A4', // hue-3
        sidebar: '#EAEAEB',
        onSidebar: '#383A42',
        onSidebarMuted: '#656873', // textMuted, darkened to 4.5 : 1 on the sidebar
        energy: '#C18401', // hue-6-2
        protein: '#50A14F', // hue-4
        carbs: '#0184BC', // hue-1
        fat: '#A626A4',
        danger: '#E45649', // hue-5
        warning: '#C18401',
        success: '#50A14F',
        track: '#DBDBDC',
      },
      { dark: '#181A1F', light: '#FFFFFF' },
    ),
  },
  {
    // Garmin Companion's "Paper": background, text, accent and warning are its published values, the rest is derived.
    id: 'paper',
    name: 'Paper',
    appearance: 'light',
    colors: defineColors(
      {
        background: '#FAF9F6',
        surface: '#FFFFFF',
        surfaceAlt: '#F1EFE8',
        border: '#E3E0D6',
        text: '#1B1A17',
        textMuted: '#6B675C',
        primary: '#B0563A',
        accent: '#2F5D50',
        sidebar: '#EFEDE5',
        onSidebar: '#1B1A17',
        onSidebarMuted: '#6B675C', // = textMuted
        energy: '#B0563A',
        protein: '#4F7A52',
        carbs: '#3F6E8C',
        fat: '#7B5E8C',
        danger: '#B3372E',
        warning: '#8A6A1F',
        success: '#3F7A4D',
        track: '#E7E4DA',
      },
      { dark: '#1B1A17', light: '#FAF9F6' },
    ),
  },
  {
    id: 'ration-day',
    name: 'Ration Day',
    appearance: 'light',
    colors: lightColors,
  },
];
