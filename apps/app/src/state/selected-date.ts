import { create } from 'zustand';

/** Local calendar date as YYYY-MM-DD (the diary is keyed by the user's LOCAL date). */
export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayISO(): string {
  return toISODate(new Date());
}

/** Adds whole days to an ISO date (DST-safe: works on the calendar date, not on milliseconds). */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return toISODate(new Date(y, m - 1, d + days));
}

/** Parses an ISO date into a local Date at noon (avoids DST edge cases). */
export function fromISODate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12);
}

interface SelectedDateState {
  date: string;
  setDate: (iso: string) => void;
  shift: (days: number) => void;
  goToday: () => void;
}

/** The diary date currently being viewed/edited. Shared by diary, food and activity flows. */
export const useSelectedDate = create<SelectedDateState>((set, get) => ({
  date: todayISO(),
  setDate: (iso) => set({ date: iso }),
  shift: (days) => set({ date: addDays(get().date, days) }),
  goToday: () => set({ date: todayISO() }),
}));
