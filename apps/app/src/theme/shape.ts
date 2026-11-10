// Pure (no React Native imports): the two corner scales ("Rounded" and "Boxy") and the helpers for round things that are not
// on the scale. The hook (theme/index.ts `useTheme()`) hands the active scale to components; nothing in the app reads a radius
// from a module-level constant any more, because a `StyleSheet.create` entry runs once at import time and could not follow the
// setting. Add a rounded element: take `radius` / `shape` from `useTheme()` and put the number inline in the style.

/** The corner style the user picked in Settings > Display > Appearance. `boxy` is the default, `rounded` the original look. */
export type Corners = 'rounded' | 'boxy';

export const CORNERS: readonly Corners[] = ['rounded', 'boxy'];

/** What a new install (and a saved choice without a corner style) gets: the boxy look. Rounded is still one tap away. */
export const DEFAULT_CORNERS: Corners = 'boxy';

/** The named corner sizes. `pill` is for things that were fully round (buttons, chips, segmented controls). */
export interface Radii {
  sm: number;
  md: number;
  lg: number;
  pill: number;
}

/** The original look. Exactly the old static `radius` constant: changing a number here changes the default look. */
export const ROUNDED_RADII: Radii = { sm: 8, md: 12, lg: 16, pill: 999 };

/**
 * The boxy look (Garmin Connect style): small, crisp corners and nothing pill-shaped. Fields, buttons and chips are 4, cards and
 * sheets 6, small badges and highlights 3. No radius is above 8.
 */
export const BOXY_RADII: Radii = { sm: 3, md: 4, lg: 6, pill: 4 };

/** Never rounder than this in the boxy look, whatever size the element is. */
export const BOXY_MAX_RADIUS = BOXY_RADII.lg;

/** The scale for a corner style. The same object every time, so it is safe in dependency lists. */
export function radiiFor(corners: Corners): Radii {
  return corners === 'boxy' ? BOXY_RADII : ROUNDED_RADII;
}

/**
 * The radius of a round button, avatar or icon tile that is `size` wide (it is a circle in the rounded look). Boxy: a rounded
 * square, never rounder than `BOXY_RADII.md`.
 */
export function circleRadius(size: number, corners: Corners): number {
  return corners === 'boxy' ? Math.min(size / 2, BOXY_RADII.md) : size / 2;
}

/**
 * The radius of a progress bar or track that is `height` tall (half its height, so the ends are round, in the rounded look).
 * Boxy: at most 2, so a bar reads as a crisp strip.
 */
export function barRadius(height: number, corners: Corners): number {
  return corners === 'boxy' ? Math.min(height / 2, 2) : height / 2;
}

/**
 * A fixed radius that is not on the scale (`n` px today). Rounded: `n`. Boxy: `n`, but never more than `BOXY_RADII.lg`, so an old
 * 14 or 20 cannot stay round.
 */
export function pxRadius(n: number, corners: Corners): number {
  return corners === 'boxy' ? Math.min(n, BOXY_MAX_RADIUS) : n;
}

/**
 * Always a circle, in both looks: for tiny status dots, legend swatches and radio buttons (up to about 24 px). Use `circle` for
 * anything bigger, which turns into a rounded square in the boxy look.
 */
export function dotRadius(size: number): number {
  return size / 2;
}

/**
 * The radius of a child that sits `inset` px inside a parent whose radius is `outer` (the segments inside a segmented control).
 * Rounded: `outer`, as before (the parent and the child both used the same pill). Boxy: `outer - inset`, at least 1, so the
 * corners stay concentric instead of the inner one looking rounder than the outer one.
 */
export function innerRadius(outer: number, inset: number, corners: Corners): number {
  return corners === 'boxy' ? Math.max(outer - inset, 1) : outer;
}

/** The four corner radii of a style object. */
export interface CornerRadii {
  borderTopLeftRadius: number;
  borderTopRightRadius: number;
  borderBottomLeftRadius: number;
  borderBottomRightRadius: number;
}

/**
 * The corners of a chat bubble: every corner `radius`, except the corner that "points at" the speaker, which is `tail` (never
 * rounder than the others). All four are written out on purpose: on the web a plain-object `borderRadius` is an inline style and
 * would beat a per-corner radius that comes from a `StyleSheet.create` class, so the tail would be lost. Spread the result into an
 * inline style and keep every radius of that element there.
 */
export function tailedRadii(radius: number, tail: number, tailCorner: 'bottomLeft' | 'bottomRight'): CornerRadii {
  const pointed = Math.min(tail, radius);
  return {
    borderTopLeftRadius: radius,
    borderTopRightRadius: radius,
    borderBottomLeftRadius: tailCorner === 'bottomLeft' ? pointed : radius,
    borderBottomRightRadius: tailCorner === 'bottomRight' ? pointed : radius,
  };
}

/** The helpers above, bound to one corner style. This is what `useTheme().shape` is. */
export interface Shape {
  circle: (size: number) => number;
  bar: (height: number) => number;
  px: (n: number) => number;
  dot: (size: number) => number;
  inner: (outer: number, inset: number) => number;
  tailed: (radius: number, tail: number, tailCorner: 'bottomLeft' | 'bottomRight') => CornerRadii;
}

function makeShape(corners: Corners): Shape {
  return {
    circle: (size) => circleRadius(size, corners),
    bar: (height) => barRadius(height, corners),
    px: (n) => pxRadius(n, corners),
    dot: dotRadius,
    inner: (outer, inset) => innerRadius(outer, inset, corners),
    tailed: tailedRadii,
  };
}

const ROUNDED_SHAPE: Shape = makeShape('rounded');
const BOXY_SHAPE: Shape = makeShape('boxy');

/** The helpers for a corner style. The same object every time. */
export function shapeFor(corners: Corners): Shape {
  return corners === 'boxy' ? BOXY_SHAPE : ROUNDED_SHAPE;
}
