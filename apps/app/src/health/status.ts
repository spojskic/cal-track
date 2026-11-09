// Live status of the health sync, shared by the foreground screen, the bootstrap hook and the background task.
import { create } from 'zustand';

import type { HealthProviderId, SyncProgress, SyncResult } from './types';

export interface HealthSyncState {
  running: boolean;
  runningProvider: HealthProviderId | null;
  trigger: 'manual' | 'foreground' | 'background' | null;
  progress: SyncProgress | null;
  /** Result of the most recent finished run in this app session. */
  lastResult: SyncResult | null;
  lastResultProvider: HealthProviderId | null;
  /** Fatal error of the most recent run (nothing could be synced). */
  lastError: string | null;
  /** Non-fatal notes (e.g. the Health Connect history window). */
  lastWarnings: string[];
  start: (provider: HealthProviderId, trigger: NonNullable<HealthSyncState['trigger']>) => void;
  setProgress: (progress: SyncProgress) => void;
  finish: (provider: HealthProviderId, result: SyncResult | null, error: string | null, warnings: string[]) => void;
}

export const useHealthSyncStore = create<HealthSyncState>((set) => ({
  running: false,
  runningProvider: null,
  trigger: null,
  progress: null,
  lastResult: null,
  lastResultProvider: null,
  lastError: null,
  lastWarnings: [],
  start: (provider, trigger) =>
    set({ running: true, runningProvider: provider, trigger, progress: null, lastError: null, lastWarnings: [] }),
  setProgress: (progress) => set({ progress }),
  finish: (provider, result, error, warnings) =>
    set({
      running: false,
      runningProvider: null,
      trigger: null,
      progress: null,
      lastResult: result,
      lastResultProvider: provider,
      lastError: error,
      lastWarnings: warnings,
    }),
}));
