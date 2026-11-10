// Live status of the Garmin sync, shared by the card, the sign-in screen and the background task (own store: the Apple Health /
// Health Connect panel must not show Garmin's progress).
import { create } from 'zustand';

import type { GarminOutcome } from './garmin-sync';

export type GarminTrigger = 'signin' | 'manual' | 'foreground' | 'background';

export interface GarminSyncState {
  running: boolean;
  trigger: GarminTrigger | null;
  /** What the running sync is doing right now, e.g. 'Reading 2026-11-09 (2 of 14)'. */
  message: string | null;
  /** Result of the most recent run in this app session. */
  lastOutcome: GarminOutcome | null;
  start: (trigger: GarminTrigger) => void;
  setMessage: (message: string) => void;
  finish: (outcome: GarminOutcome | null) => void;
}

export const useGarminSyncStore = create<GarminSyncState>((set) => ({
  running: false,
  trigger: null,
  message: null,
  lastOutcome: null,
  start: (trigger) => set({ running: true, trigger, message: null }),
  setMessage: (message) => set({ message }),
  finish: (outcome) => set({ running: false, trigger: null, message: null, lastOutcome: outcome }),
}));
