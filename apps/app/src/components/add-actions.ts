import type { SymbolViewProps } from 'expo-symbols';

export type AddSectionKey = 'food' | 'activity';

/** One thing the "+" can add. Shared by the "+" sheet (app/add.tsx) and the "..." menu on the Add food screen. */
export interface AddAction {
  key: string;
  section: AddSectionKey;
  label: string;
  hint: string;
  /** Destination route. */
  route: string;
  symbol: SymbolViewProps['name'];
  /** AI actions are hidden unless useAiGate().enabled (valid key + vision-capable model). */
  ai?: boolean;
}

export const ADD_SECTIONS: { key: AddSectionKey; title: string }[] = [
  { key: 'food', title: 'Food' },
  { key: 'activity', title: 'Activity and health' },
];

export const ADD_ACTIONS: AddAction[] = [
  {
    key: 'search',
    section: 'food',
    label: 'Search food',
    hint: 'Find a food and log it',
    route: '/search',
    symbol: { ios: 'magnifyingglass', android: 'search', web: 'search' },
  },
  {
    key: 'barcode',
    section: 'food',
    label: 'Scan barcode',
    hint: 'Look up a packaged product',
    route: '/scan',
    symbol: { ios: 'barcode.viewfinder', android: 'qr_code_scanner', web: 'qr_code_scanner' },
  },
  {
    key: 'custom-food',
    section: 'food',
    label: 'Create custom food',
    hint: 'Add your own food with nutrition facts',
    route: '/food/new',
    symbol: { ios: 'plus.circle.fill', android: 'add_circle', web: 'add_circle' },
  },
  // ---- AI actions (routes /ai/photo, /ai/describe and /ai/label).
  // Keep `ai: true` so the useAiGate() filter below hides them unless AI is enabled.
  {
    key: 'photo',
    section: 'food',
    label: 'Photo log',
    hint: 'Snap your meal, AI estimates it',
    route: '/ai/photo',
    symbol: { ios: 'camera.fill', android: 'photo_camera', web: 'photo_camera' },
    ai: true,
  },
  {
    key: 'describe',
    section: 'food',
    label: 'Describe meal',
    hint: 'Type what you ate, AI fills it in',
    route: '/ai/describe',
    symbol: { ios: 'text.bubble.fill', android: 'chat', web: 'chat' },
    ai: true,
  },
  {
    key: 'label',
    section: 'food',
    label: 'Scan nutrition label',
    hint: 'Photograph a label, AI fills in a new food',
    route: '/ai/label',
    symbol: { ios: 'doc.text.viewfinder', android: 'document_scanner', web: 'document_scanner' },
    ai: true,
  },
  // ---- end AI placeholders
  {
    key: 'exercise',
    section: 'activity',
    label: 'Add exercise',
    hint: 'Log a workout',
    route: '/exercise/new',
    symbol: { ios: 'figure.run', android: 'directions_run', web: 'directions_run' },
  },
  {
    key: 'biometric',
    section: 'activity',
    label: 'Add biometric',
    hint: 'Weight, blood pressure, glucose, ...',
    route: '/biometric/new',
    symbol: { ios: 'waveform.path.ecg', android: 'monitor_heart', web: 'monitor_heart' },
  },
  {
    key: 'note',
    section: 'activity',
    label: 'Add note',
    hint: 'Write a diary note',
    route: '/note/new',
    symbol: { ios: 'note.text', android: 'sticky_note_2', web: 'sticky_note_2' },
  },
  {
    key: 'water',
    section: 'activity',
    label: 'Add water',
    hint: 'Log a drink',
    route: '/water/new',
    symbol: { ios: 'drop.fill', android: 'water_drop', web: 'water_drop' },
  },
];
