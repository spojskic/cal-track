// Which sidebar groups are collapsed, as a small zustand store (same pattern as theme/theme-store.ts): a versioned key, best-effort
// load and save, device-local. The rules (defaults, tolerant parsing) are in sidebar-state.ts.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { create } from 'zustand';

import { migrateAsyncKey } from '@/lib/migrate-key';

import {
  SIDEBAR_STORAGE_KEY,
  isSectionCollapsed,
  parseSidebarState,
  serializeSidebarState,
  toggleSection,
  type SidebarSectionId,
  type SidebarState,
} from './sidebar-state';

interface SidebarStoreState extends SidebarState {
  /** The saved choice was read (always true on the web, where it is read synchronously). */
  hydrated: boolean;
  toggle: (id: SidebarSectionId) => void;
  /** Native: reads the saved choice. Does nothing once the choice was read or changed. */
  hydrate: () => Promise<void>;
}

/** The sidebar key from before the app was renamed; read once, then moved to `SIDEBAR_STORAGE_KEY`. */
const LEGACY_SIDEBAR_STORAGE_KEY = 'cal-track.sidebar.v1';

/** Web: localStorage is synchronous, so the sidebar is drawn the way the user left it from the first frame. */
function readWebSync(): string | null {
  if (Platform.OS !== 'web') return null;
  try {
    if (typeof localStorage === 'undefined') return null;
    const current = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (current !== null) return current;
    const legacy = localStorage.getItem(LEGACY_SIDEBAR_STORAGE_KEY);
    if (legacy === null) return null;
    localStorage.setItem(SIDEBAR_STORAGE_KEY, legacy);
    localStorage.removeItem(LEGACY_SIDEBAR_STORAGE_KEY);
    return legacy;
  } catch {
    return null;
  }
}

async function save(state: SidebarState): Promise<void> {
  try {
    await AsyncStorage.setItem(SIDEBAR_STORAGE_KEY, serializeSidebarState(state));
  } catch {
    // best effort: the groups stay as they are until the app closes
  }
}

export const useSidebarStore = create<SidebarStoreState>()((set, get) => ({
  ...parseSidebarState(readWebSync()),
  hydrated: Platform.OS === 'web',
  toggle: (id) => {
    const next = toggleSection({ collapsed: get().collapsed }, id);
    set({ ...next, hydrated: true });
    void save(next);
  },
  hydrate: async () => {
    if (get().hydrated) return;
    let stored: string | null = null;
    try {
      await migrateAsyncKey(LEGACY_SIDEBAR_STORAGE_KEY, SIDEBAR_STORAGE_KEY);
      stored = await AsyncStorage.getItem(SIDEBAR_STORAGE_KEY);
    } catch {
      // an unreadable store means the defaults
    }
    // the user may have toggled a group while the read was running: their choice wins
    if (get().hydrated) return;
    set({ ...parseSidebarState(stored), hydrated: true });
  },
}));

/** True when the group is collapsed (false until the user collapses it; the calendar starts collapsed). */
export function useSectionCollapsed(id: SidebarSectionId): boolean {
  return useSidebarStore((s) => isSectionCollapsed(s, id));
}

if (Platform.OS !== 'web') void useSidebarStore.getState().hydrate();
