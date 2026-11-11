// Pure (no React Native imports): the dark palettes. Colours are the published ones of each theme; where a value had to be
// adjusted to reach the contrast floors of theme.test.ts the line says `nudged`.
import { darkColors, type PaletteDef } from './colors';
import { defineColors } from './define-colors';

export const DARK_PALETTES: readonly PaletteDef[] = [
  {
    // kanagawa.nvim "wave" (the default dark palette)
    id: 'kanagawa-wave',
    name: 'Kanagawa Wave',
    appearance: 'dark',
    colors: defineColors(
      {
        background: '#1F1F28', // sumiInk3
        surface: '#2A2A37', // sumiInk4
        surfaceAlt: '#1A1A22', // sumiInk2
        border: '#363646', // sumiInk5
        text: '#DCD7BA', // fujiWhite
        textMuted: '#A09E8A', // fujiGray, lightened
        primary: '#7AA89F', // waveAqua2
        accent: '#7E9CD8', // crystalBlue
        sidebar: '#16161D', // sumiInk0
        onSidebar: '#DCD7BA',
        onSidebarMuted: '#A09E8A', // = textMuted
        energy: '#FFA066', // surimiOrange
        protein: '#98BB6C', // springGreen
        carbs: '#7FB4CA', // springBlue
        fat: '#957FB8', // oniViolet
        danger: '#E46876', // waveRed
        warning: '#E6C384', // carpYellow
        success: '#98BB6C',
        track: '#363646',
      },
      { dark: '#16161D', light: '#DCD7BA' },
    ),
  },
  {
    // kanagawa.nvim "dragon"
    id: 'kanagawa-dragon',
    name: 'Kanagawa Dragon',
    appearance: 'dark',
    colors: defineColors(
      {
        background: '#181616', // dragonBlack3
        surface: '#282727', // dragonBlack4
        surfaceAlt: '#12120F', // dragonBlack1
        border: '#393836', // dragonBlack5
        text: '#C5C9C5', // dragonWhite
        textMuted: '#A6A69C', // dragonGray
        primary: '#8EA4A2', // dragonAqua
        accent: '#8992A7', // dragonViolet
        sidebar: '#0D0C0C', // dragonBlack0
        onSidebar: '#C5C9C5',
        onSidebarMuted: '#A6A69C', // = textMuted
        energy: '#B6927B', // dragonOrange
        protein: '#87A987', // dragonGreen
        carbs: '#8BA4B0', // dragonBlue2
        fat: '#A292A3', // dragonPink
        danger: '#C4746E', // dragonRed
        warning: '#C4B28A', // dragonYellow
        success: '#8A9A7B', // dragonGreen2
        track: '#393836',
      },
      { dark: '#0D0C0C', light: '#C5C9C5' },
    ),
  },
  {
    // tokyonight.nvim "night"
    id: 'tokyo-night',
    name: 'Tokyo Night',
    appearance: 'dark',
    colors: defineColors(
      {
        background: '#1A1B26',
        surface: '#24283B', // storm bg
        surfaceAlt: '#16161E', // bg_dark
        border: '#3B4261', // fg_gutter
        text: '#C0CAF5',
        textMuted: '#888EB0', // nudged from #737AA2 (dark5)
        primary: '#7AA2F7', // blue
        accent: '#2AC3DE', // blue1
        sidebar: '#16161E',
        onSidebar: '#C0CAF5',
        onSidebarMuted: '#888EB0', // = textMuted
        energy: '#FF9E64', // orange
        protein: '#9ECE6A', // green
        carbs: '#7DCFFF', // cyan
        fat: '#BB9AF7', // magenta
        danger: '#F7768E', // red
        warning: '#E0AF68', // yellow
        success: '#9ECE6A',
        track: '#292E42', // bg_highlight
      },
      { dark: '#15161E', light: '#C0CAF5' },
    ),
  },
  {
    // Catppuccin Mocha
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    appearance: 'dark',
    colors: defineColors(
      {
        background: '#1E1E2E', // base
        surface: '#313244', // surface0
        surfaceAlt: '#181825', // mantle
        border: '#45475A', // surface1
        text: '#CDD6F4',
        textMuted: '#A6ADC8', // subtext0
        primary: '#CBA6F7', // mauve
        accent: '#89B4FA', // blue
        sidebar: '#11111B', // crust
        onSidebar: '#CDD6F4',
        onSidebarMuted: '#A6ADC8', // = textMuted
        energy: '#FAB387', // peach
        protein: '#A6E3A1', // green
        carbs: '#89DCEB', // sky
        fat: '#F5C2E7', // pink
        danger: '#F38BA8', // red
        warning: '#F9E2AF', // yellow
        success: '#A6E3A1',
        track: '#45475A',
      },
      { dark: '#11111B', light: '#CDD6F4' },
    ),
  },
  {
    // Dracula
    id: 'dracula',
    name: 'Dracula',
    appearance: 'dark',
    colors: defineColors(
      {
        background: '#282A36',
        surface: '#343746', // between background and current line
        surfaceAlt: '#21222C', // dracula UI darker
        border: '#44475A', // current line
        text: '#F8F8F2',
        textMuted: '#96A0C2', // nudged from #6272A4 (comment)
        primary: '#BD93F9', // purple
        accent: '#FF79C6', // pink
        sidebar: '#191A21',
        onSidebar: '#F8F8F2',
        onSidebarMuted: '#96A0C2', // = textMuted
        energy: '#FFB86C', // orange
        protein: '#50FA7B', // green
        carbs: '#8BE9FD', // cyan
        fat: '#FF79C6',
        danger: '#FF5555', // red
        warning: '#F1FA8C', // yellow
        success: '#50FA7B',
        track: '#44475A',
      },
      { dark: '#191A21', light: '#F8F8F2' },
    ),
  },
  {
    // Nord
    id: 'nord',
    name: 'Nord',
    appearance: 'dark',
    colors: defineColors(
      {
        background: '#2E3440', // nord0
        surface: '#3B4252', // nord1
        surfaceAlt: '#272C36', // darker shade of nord0
        border: '#434C5E', // nord2
        text: '#D8DEE9', // nord4
        textMuted: '#A5AEBF', // nudged from #7B88A1
        primary: '#88C0D0', // nord8
        accent: '#81A1C1', // nord9
        sidebar: '#242933',
        onSidebar: '#D8DEE9',
        onSidebarMuted: '#A5AEBF', // = textMuted
        energy: '#D08770', // nord12
        protein: '#A3BE8C', // nord14
        carbs: '#8FBCBB', // nord7
        fat: '#B48EAD', // nord15
        danger: '#C7757D', // nudged from #BF616A (nord11)
        warning: '#EBCB8B', // nord13
        success: '#A3BE8C',
        track: '#434C5E',
      },
      { dark: '#242933', light: '#ECEFF4' },
    ),
  },
  {
    // Gruvbox Dark (medium)
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    appearance: 'dark',
    colors: defineColors(
      {
        background: '#282828', // bg0
        surface: '#3C3836', // bg1
        surfaceAlt: '#1D2021', // bg0_h
        border: '#504945', // bg2
        text: '#EBDBB2', // fg1
        textMuted: '#AEA08D', // nudged from #A89984 (fg4)
        primary: '#8EC07C', // bright aqua
        accent: '#83A598', // bright blue
        sidebar: '#1D2021',
        onSidebar: '#EBDBB2',
        onSidebarMuted: '#AEA08D', // = textMuted
        energy: '#FE8019', // bright orange
        protein: '#B8BB26', // bright green
        carbs: '#83A598',
        fat: '#D3869B', // bright purple
        danger: '#FB4934', // bright red
        warning: '#FABD2F', // bright yellow
        success: '#B8BB26',
        track: '#504945',
      },
      { dark: '#1D2021', light: '#FBF1C7' },
    ),
  },
  {
    // Rosé Pine
    id: 'rose-pine',
    name: 'Rosé Pine',
    appearance: 'dark',
    colors: defineColors(
      {
        background: '#191724', // base
        surface: '#1F1D2E', // surface
        surfaceAlt: '#26233A', // overlay
        border: '#403D52', // highlight med
        text: '#E0DEF4',
        textMuted: '#908CAA', // subtle
        primary: '#C4A7E7', // iris
        accent: '#9CCFD8', // foam
        sidebar: '#1F1D2E',
        onSidebar: '#E0DEF4',
        onSidebarMuted: '#908CAA', // = textMuted
        energy: '#EBBCBA', // rose
        protein: '#9CCFD8', // foam
        carbs: '#3E8FB0', // pine (moon)
        fat: '#C4A7E7',
        danger: '#EB6F92', // love
        warning: '#F6C177', // gold
        success: '#9CCFD8',
        track: '#403D52',
      },
      { dark: '#191724', light: '#E0DEF4' },
    ),
  },
  {
    // Atom One Dark
    id: 'one-dark',
    name: 'One Dark',
    appearance: 'dark',
    colors: defineColors(
      {
        background: '#282C34',
        surface: '#2C313A',
        surfaceAlt: '#21252B',
        border: '#3E4451',
        text: '#B2B9C5', // nudged from #ABB2BF
        textMuted: '#9399A5', // nudged from #828997 (mono-2)
        primary: '#61AFEF', // blue
        accent: '#C678DD', // purple
        sidebar: '#21252B',
        onSidebar: '#ABB2BF',
        onSidebarMuted: '#9399A5', // = textMuted
        energy: '#D19A66', // orange
        protein: '#98C379', // green
        carbs: '#56B6C2', // cyan
        fat: '#C678DD',
        danger: '#E06C75', // red
        warning: '#E5C07B', // yellow
        success: '#98C379',
        track: '#3E4451',
      },
      { dark: '#21252B', light: '#ABB2BF' },
    ),
  },
  {
    // GitHub Primer, dark default
    id: 'github-dark',
    name: 'GitHub Dark',
    appearance: 'dark',
    colors: defineColors(
      {
        background: '#0D1117', // canvas default
        surface: '#161B22', // canvas subtle
        surfaceAlt: '#010409', // canvas inset
        border: '#30363D',
        text: '#E6EDF3',
        textMuted: '#8B949E',
        primary: '#58A6FF', // accent fg
        accent: '#BC8CFF', // done fg
        sidebar: '#010409',
        onSidebar: '#E6EDF3',
        onSidebarMuted: '#8B949E', // = textMuted
        energy: '#DB6D28', // severe fg
        protein: '#3FB950', // success fg
        carbs: '#39C5CF', // cyan
        fat: '#BC8CFF',
        danger: '#F85149', // danger fg
        warning: '#D29922', // attention fg
        success: '#3FB950',
        track: '#21262D',
      },
      { dark: '#010409', light: '#E6EDF3' },
    ),
  },
  {
    // Solarized Dark
    id: 'solarized-dark',
    name: 'Solarized Dark',
    appearance: 'dark',
    colors: defineColors(
      {
        background: '#002B36', // base03
        surface: '#073642', // base02
        surfaceAlt: '#00212B', // darker shade of base03
        border: '#1B4955', // derived (between base02 and base01)
        text: '#EEE8D5', // base2
        textMuted: '#93A1A1', // base1
        primary: '#268BD2', // blue
        accent: '#6C71C4', // violet
        sidebar: '#00212B',
        onSidebar: '#EEE8D5',
        onSidebarMuted: '#93A1A1', // = textMuted
        energy: '#CB4B16', // orange
        protein: '#859900', // green
        carbs: '#2AA198', // cyan
        fat: '#D33682', // magenta
        danger: '#DE3F3C', // nudged from #DC322F (red)
        warning: '#B58900', // yellow
        success: '#859900',
        track: '#1B4955',
      },
      { dark: '#00212B', light: '#FDF6E3' },
    ),
  },
  {
    id: 'ration-night',
    name: 'Ration Night',
    appearance: 'dark',
    colors: darkColors,
  },
];
