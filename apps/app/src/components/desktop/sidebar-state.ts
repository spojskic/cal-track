// Pure (no React Native imports): which sidebar groups the user collapsed, and how that choice is saved and read back. The store
// (sidebar-store.ts) is the AsyncStorage / zustand side of this.

/** The groups of the sidebar that can be collapsed: the six groups of the rows and the calendar. */
export const SIDEBAR_SECTION_IDS = ['daily', 'training', 'coach', 'profile', 'connections', 'app', 'calendar'] as const;
export type SidebarSectionId = (typeof SIDEBAR_SECTION_IDS)[number];

/** localStorage / AsyncStorage key. The version is part of the key: change the shape, bump it. */
export const SIDEBAR_STORAGE_KEY = 'cal-track.sidebar.v1';

/**
 * What the user chose: for each group they touched, whether it is collapsed. A group that is missing has its default (the rows are
 * open, the calendar is closed), so a group added in a later version starts the way it should.
 */
export interface SidebarState {
  collapsed: Partial<Record<SidebarSectionId, boolean>>;
}

export const DEFAULT_SIDEBAR_STATE: SidebarState = { collapsed: {} };

/** Collapsed unless the user opened it: the calendar is a month grid that most people only want on demand. */
export const COLLAPSED_BY_DEFAULT: Readonly<Record<SidebarSectionId, boolean>> = {
  daily: false,
  training: false,
  coach: false,
  profile: false,
  connections: false,
  app: false,
  calendar: true,
};

export function isSidebarSectionId(value: unknown): value is SidebarSectionId {
  return typeof value === 'string' && (SIDEBAR_SECTION_IDS as readonly string[]).includes(value);
}

export function isSectionCollapsed(state: SidebarState, id: SidebarSectionId): boolean {
  return state.collapsed[id] ?? COLLAPSED_BY_DEFAULT[id];
}

export function setSectionCollapsed(state: SidebarState, id: SidebarSectionId, collapsed: boolean): SidebarState {
  return { collapsed: { ...state.collapsed, [id]: collapsed } };
}

export function toggleSection(state: SidebarState, id: SidebarSectionId): SidebarState {
  return setSectionCollapsed(state, id, !isSectionCollapsed(state, id));
}

/**
 * Makes any value (parsed JSON, `null`, a payload of an older or newer version) a valid state: only the known groups with a true or
 * false value are kept, everything else is dropped.
 */
export function sanitizeSidebarState(raw: unknown): SidebarState {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const stored = typeof o.collapsed === 'object' && o.collapsed !== null && !Array.isArray(o.collapsed) ? (o.collapsed as Record<string, unknown>) : {};
  const collapsed: SidebarState['collapsed'] = {};
  for (const id of SIDEBAR_SECTION_IDS) {
    const value = stored[id];
    if (typeof value === 'boolean') collapsed[id] = value;
  }
  return { collapsed };
}

/** Reads the stored string. Never throws: anything unreadable gives the defaults. */
export function parseSidebarState(stored: string | null | undefined): SidebarState {
  if (!stored) return DEFAULT_SIDEBAR_STATE;
  try {
    return sanitizeSidebarState(JSON.parse(stored));
  } catch {
    return DEFAULT_SIDEBAR_STATE;
  }
}

export function serializeSidebarState(state: SidebarState): string {
  return JSON.stringify({ v: 1, collapsed: sanitizeSidebarState(state).collapsed });
}
