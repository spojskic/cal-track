// Pure (no React Native imports): how many palette cards fit in a row, and how wide each one is.

/** The narrowest a palette card may get before the grid drops a column. */
export const PALETTE_CARD_MIN_WIDTH = 132;
/** Space between cards, in both directions. */
export const PALETTE_GRID_GAP = 12;
const MIN_COLUMNS = 2;
const MAX_COLUMNS = 5;

/** Two columns on a phone, up to five on a wide screen. */
export function paletteColumns(containerWidth: number): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return MIN_COLUMNS;
  const fit = Math.floor((containerWidth + PALETTE_GRID_GAP) / (PALETTE_CARD_MIN_WIDTH + PALETTE_GRID_GAP));
  return Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, fit));
}

/** Width of one card so `columns` cards and their gaps fill the container exactly (rounded down to whole pixels). */
export function paletteCardWidth(containerWidth: number, columns: number): number {
  return Math.floor((containerWidth - PALETTE_GRID_GAP * (columns - 1)) / columns);
}
