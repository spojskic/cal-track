// In-app clipboard of "Copy Group" / "Copy Entry" on the diary. In memory only: it lasts until the app is closed.
import { create } from 'zustand';

import type { DiaryClipboard } from '@/data/diary-copy';

interface DiaryClipboardState {
  clip: DiaryClipboard | null;
  setClip: (clip: DiaryClipboard | null) => void;
}

export const useDiaryClipboard = create<DiaryClipboardState>((set) => ({
  clip: null,
  setClip: (clip) => set({ clip }),
}));
