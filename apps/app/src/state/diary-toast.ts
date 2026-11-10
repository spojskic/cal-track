// One toast ("Copied 4 items" + Undo) for the diary. A store rather than component state so the menus, sheets and
// hooks that perform an action can announce it without prop drilling; <ToastHost /> (components/diary) renders it.
import { create } from 'zustand';

export interface ToastAction {
  label: string;
  onPress: () => void;
}

export interface DiaryToast {
  id: number;
  message: string;
  tone: 'success' | 'error';
  action: ToastAction | undefined;
}

export interface ToastRequest {
  message: string;
  tone?: 'success' | 'error';
  action?: ToastAction;
  /** How long it stays. Default: 8 s with an action, 6 s for errors, 4 s otherwise. */
  durationMs?: number;
}

export const useDiaryToast = create<{ toast: DiaryToast | null }>(() => ({ toast: null }));

let sequence = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Hides the toast (only the given one when an id is passed, so a late timer cannot close a newer toast). */
export function dismissDiaryToast(id?: number): void {
  const current = useDiaryToast.getState().toast;
  if (!current || (id !== undefined && current.id !== id)) return;
  if (timer) clearTimeout(timer);
  timer = null;
  useDiaryToast.setState({ toast: null });
}

/** Shows a toast, replacing the current one. Returns its id. */
export function showDiaryToast(request: ToastRequest): number {
  if (timer) clearTimeout(timer);
  sequence += 1;
  const id = sequence;
  const tone = request.tone ?? 'success';
  useDiaryToast.setState({ toast: { id, message: request.message, tone, action: request.action } });
  const duration = request.durationMs ?? (request.action ? 8000 : tone === 'error' ? 6000 : 4000);
  timer = setTimeout(() => dismissDiaryToast(id), duration);
  return id;
}
