import type { ReactNode } from 'react';

/** Web: no gesture handlers are used (rows are deleted from the entry sheet), so the tree is left exactly as it is. */
export function GestureRoot({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
