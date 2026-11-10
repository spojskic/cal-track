/**
 * Corner styles (Rounded / Boxy): the pure scales in apps/app/src/theme/shape.ts, and a guard over the app's source that keeps
 * every rounded corner dynamic. A `StyleSheet.create` entry runs once at import time, so a static `radius.lg` or a literal
 * `borderRadius: 16` there could never follow the Boxy switch; the guard fails the build when somebody brings one back.
 *
 * Pure Node: shape.ts imports no React Native, and the guard only reads the source files as text.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BOXY_MAX_RADIUS,
  BOXY_RADII,
  CORNERS,
  DEFAULT_CORNERS,
  ROUNDED_RADII,
  barRadius,
  circleRadius,
  dotRadius,
  innerRadius,
  pxRadius,
  radiiFor,
  shapeFor,
  tailedRadii,
} from '../../../apps/app/src/theme/shape';

const here = dirname(fileURLToPath(import.meta.url));
const APP_SRC = join(here, '..', '..', '..', 'apps', 'app', 'src');

// ---------------------------------------------------------------------------------------------------------------------------
// The scales and the helpers
// ---------------------------------------------------------------------------------------------------------------------------

describe('corner scales', () => {
  it('Rounded is exactly the old static scale (the default look does not change)', () => {
    expect(DEFAULT_CORNERS).toBe('rounded');
    expect(ROUNDED_RADII).toEqual({ sm: 8, md: 12, lg: 16, pill: 999 });
    expect(radiiFor('rounded')).toBe(ROUNDED_RADII);
  });

  it('Boxy is small and crisp: fields and buttons 4, cards and sheets 6, badges and highlights 3, nothing above 8, nothing pill-shaped', () => {
    expect(BOXY_RADII).toEqual({ sm: 3, md: 4, lg: 6, pill: 4 });
    expect(radiiFor('boxy')).toBe(BOXY_RADII);
    for (const [name, value] of Object.entries(BOXY_RADII)) {
      expect(value, name).toBeGreaterThan(0);
      expect(value, name).toBeLessThanOrEqual(8);
    }
    expect(BOXY_RADII.sm).toBeLessThanOrEqual(BOXY_RADII.md);
    expect(BOXY_RADII.md).toBeLessThanOrEqual(BOXY_RADII.lg);
    expect(BOXY_MAX_RADIUS).toBe(BOXY_RADII.lg);
  });

  it('both scales have the same names, so a component never needs to know which one it got', () => {
    expect(Object.keys(BOXY_RADII)).toEqual(Object.keys(ROUNDED_RADII));
    expect(CORNERS).toEqual(['rounded', 'boxy']);
  });
});

describe('radius helpers', () => {
  it('circle: half the size when Rounded, a rounded square (at most 4) when Boxy', () => {
    expect(circleRadius(38, 'rounded')).toBe(19); // food row "+"
    expect(circleRadius(58, 'rounded')).toBe(29); // tab bar button
    expect(circleRadius(46, 'rounded')).toBe(23); // Button
    expect(circleRadius(40, 'rounded')).toBe(20); // IconButton, back button, workout icon
    expect(circleRadius(38, 'boxy')).toBe(4);
    expect(circleRadius(58, 'boxy')).toBe(4);
    expect(circleRadius(46, 'boxy')).toBe(4);
    expect(circleRadius(6, 'boxy')).toBe(3); // never more than half
  });

  it('bar: half the height when Rounded, a crisp 2 at most when Boxy', () => {
    expect(barRadius(8, 'rounded')).toBe(4);
    expect(barRadius(10, 'rounded')).toBe(5);
    expect(barRadius(16, 'rounded')).toBe(8); // the heart-rate zone bar was radius.sm = 8
    expect(barRadius(6, 'rounded')).toBe(3);
    expect(barRadius(8, 'boxy')).toBe(2);
    expect(barRadius(16, 'boxy')).toBe(2);
    expect(barRadius(3, 'boxy')).toBe(1.5);
  });

  it('px: a fixed radius is unchanged when Rounded and never above the Boxy card radius when Boxy', () => {
    expect(pxRadius(24, 'rounded')).toBe(24); // the barcode frame was radius.lg + 8
    expect(pxRadius(14, 'rounded')).toBe(14);
    expect(pxRadius(24, 'boxy')).toBe(6);
    expect(pxRadius(14, 'boxy')).toBe(6);
    expect(pxRadius(3, 'boxy')).toBe(3);
    expect(pxRadius(2, 'boxy')).toBe(2);
  });

  it('dot: always a circle, in both looks', () => {
    for (const size of [8, 10, 20, 22]) expect(dotRadius(size)).toBe(size / 2);
  });

  it('inner: Rounded keeps the outer radius (as before), Boxy stays concentric and never below 1', () => {
    expect(innerRadius(999, 3, 'rounded')).toBe(999);
    expect(innerRadius(999, 2, 'rounded')).toBe(999);
    expect(innerRadius(4, 3, 'boxy')).toBe(1);
    expect(innerRadius(4, 2, 'boxy')).toBe(2);
    expect(innerRadius(3, 3, 'boxy')).toBe(1);
  });

  it('tailed: every corner is written out, the pointed one is the small tail and never rounder than the others', () => {
    expect(tailedRadii(16, 4, 'bottomRight')).toEqual({
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      borderBottomLeftRadius: 16,
      borderBottomRightRadius: 4,
    });
    expect(tailedRadii(16, 4, 'bottomLeft')).toEqual({
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      borderBottomLeftRadius: 4,
      borderBottomRightRadius: 16,
    });
    expect(tailedRadii(6, 4, 'bottomLeft').borderBottomLeftRadius).toBe(4); // Boxy chat bubble
    expect(tailedRadii(3, 4, 'bottomLeft').borderBottomLeftRadius).toBe(3);
    expect(tailedRadii(0, 4, 'bottomRight').borderBottomRightRadius).toBe(0);
  });

  it('nothing is bigger than the Boxy card radius when Boxy, whatever the size', () => {
    for (let size = 1; size <= 400; size += 1) {
      expect(circleRadius(size, 'boxy'), `circle ${size}`).toBeLessThanOrEqual(BOXY_MAX_RADIUS);
      expect(barRadius(size, 'boxy'), `bar ${size}`).toBeLessThanOrEqual(2);
      expect(pxRadius(size, 'boxy'), `px ${size}`).toBeLessThanOrEqual(BOXY_MAX_RADIUS);
      // and Rounded keeps the old half-size circles exactly
      expect(circleRadius(size, 'rounded')).toBe(size / 2);
      expect(barRadius(size, 'rounded')).toBe(size / 2);
      expect(pxRadius(size, 'rounded')).toBe(size);
    }
  });

  it('shapeFor binds the helpers to a corner style and returns the same object every time (stable for useMemo)', () => {
    for (const corners of CORNERS) {
      const shape = shapeFor(corners);
      expect(shapeFor(corners)).toBe(shape);
      expect(shape.circle(38)).toBe(circleRadius(38, corners));
      expect(shape.bar(8)).toBe(barRadius(8, corners));
      expect(shape.px(14)).toBe(pxRadius(14, corners));
      expect(shape.dot(10)).toBe(5);
      expect(shape.inner(4, 2)).toBe(innerRadius(4, 2, corners));
      expect(shape.tailed(radiiFor(corners).lg, 4, 'bottomLeft')).toEqual(tailedRadii(radiiFor(corners).lg, 4, 'bottomLeft'));
    }
    expect(shapeFor('rounded')).not.toBe(shapeFor('boxy'));
  });

  it('the converted components produce the numbers they had before when Rounded', () => {
    const { circle, bar, px, dot, inner, tailed } = shapeFor('rounded');
    const r = radiiFor('rounded');
    // [what the component draws now, what it drew before the switch existed]
    const table: [string, number, number][] = [
      ['Card', r.lg, 16],
      ['TextField, option rows, previews', r.md, 12],
      ['list row highlight, notes', r.sm, 8],
      ['Button (minHeight 46: a pill)', circle(46), 23],
      ['IconButton 40, back button 40, workout icon 40', circle(40), 20],
      ['IconButton 36 (sheet close)', circle(36), 18],
      ['food row quick add 38', circle(38), 19],
      ['tab bar centre button 58', circle(58), 29],
      ['count badge in the diary tabs 18', circle(18), 9],
      ['streak day marker 22', circle(22), 11],
      ['theme picker check 20', circle(20), 10],
      ['radio 22 (option list)', dot(22), 11],
      ['radio 20 (model picker)', dot(20), 10],
      ['completeness dot 8', dot(8), 4],
      ['barcode viewfinder frame', px(24), r.lg + 8],
      ['heart-rate zone bar 16 (was radius.sm)', bar(16), r.sm],
      ['macro split bar 8 (was a literal 4)', bar(8), 4],
      ['onboarding progress segment 6 (was a literal 3)', bar(6), 3],
      ['pager dot 6 (was a literal 3)', bar(6), 3],
      ['mini bar chart column and checkbox (was radius.sm / 2)', r.sm / 2, 4],
      ['segmented control segments (same pill as the control)', inner(r.pill, 3), 999],
      ['pill things (chips, search boxes, badges)', r.pill, 999],
      ['chat bubble: the pointed corner (was spacing.xs)', tailed(r.lg, 4, 'bottomRight').borderBottomRightRadius, 4],
      ['chat bubble: the other three corners (were radius.lg)', tailed(r.lg, 4, 'bottomRight').borderTopLeftRadius, 16],
    ];
    for (const [what, now, before] of table) expect(now, what).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// The guard: no static round corners in the app
// ---------------------------------------------------------------------------------------------------------------------------

/** Files (relative to apps/app/src, `/` separators) that may keep a literal `borderRadius` of 6 or more, with the reason. */
const ALLOWLIST: Record<string, string> = {
  // Empty on purpose. A tiny round dot is written `borderRadius: 5` (below 6), a bigger round thing takes `shape.circle(size)`
  // or `shape.dot(size)` from `useTheme()`. Add an entry only for something that must look the same in both corner styles.
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const rel = (file: string): string => relative(APP_SRC, file).split(sep).join('/');

/** Source without comments, so that talking about `borderRadius: 16` in a comment is fine. (Good enough for this codebase.) */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** Names imported from the theme module: `import { a, b as c } from '@/theme'` (also relative paths into theme/). */
function themeImports(source: string): string[] {
  const names: string[] = [];
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"](?:@\/theme(?:\/[^'"]*)?|(?:\.{1,2}\/)+theme(?:\/[^'"]*)?)['"]/g;
  for (const m of source.matchAll(re)) {
    for (const part of (m[1] ?? '').split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

/** Literal radii of 6 or more: `borderRadius: 12`, `borderTopLeftRadius: 999`, also with quotes or a minus sign. */
function bigLiteralRadii(source: string): { text: string; value: number }[] {
  const out: { text: string; value: number }[] = [];
  const re = /\bborder(?:Top|Bottom)?(?:Left|Right)?Radius\s*:\s*(\d+(?:\.\d+)?)\b/g;
  for (const m of stripComments(source).matchAll(re)) {
    const value = Number(m[1]);
    if (value >= 6) out.push({ text: m[0], value });
  }
  return out;
}

const files = walk(APP_SRC).map((file) => ({ path: rel(file), source: readFileSync(file, 'utf8') }));
const outsideTheme = files.filter((f) => !f.path.startsWith('theme/'));

describe('shape guard: no rounded corner is frozen at import time', () => {
  it('reads the whole app (a guard over no files would pass for the wrong reason)', () => {
    expect(files.length).toBeGreaterThan(150);
    expect(files.some((f) => f.path === 'theme/shape.ts')).toBe(true);
    expect(outsideTheme.some((f) => f.path === 'components/ui.tsx')).toBe(true);
  });

  it('(a) nothing outside theme/ imports a static radius or a corner scale: radii come from useTheme()', () => {
    const offenders: string[] = [];
    for (const f of outsideTheme) {
      for (const name of themeImports(stripComments(f.source))) {
        if (['radius', 'ROUNDED_RADII', 'BOXY_RADII', 'radiiFor', 'shapeFor', 'circleRadius', 'barRadius', 'pxRadius', 'dotRadius', 'innerRadius'].includes(name)) {
          offenders.push(`${f.path} imports ${name}`);
        }
      }
      if (/from\s+['"](?:@\/theme\/shape|(?:\.{1,2}\/)+theme\/shape)['"]/.test(stripComments(f.source))) {
        offenders.push(`${f.path} imports theme/shape directly (use useTheme().radius / .shape)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('(b) no borderRadius with a literal of 6 or more outside the allowlist', () => {
    const offenders: string[] = [];
    for (const f of outsideTheme) {
      if (f.path in ALLOWLIST) continue;
      for (const hit of bigLiteralRadii(f.source)) offenders.push(`${f.path}: ${hit.text}`);
    }
    expect(offenders).toEqual([]);
  });

  it('(c) 999 is not written as a radius anywhere outside theme/shape.ts, not even in an allowlisted file', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (f.path === 'theme/shape.ts') continue;
      if (/[rR]adius\s*:\s*999\b/.test(stripComments(f.source))) offenders.push(f.path);
    }
    expect(offenders).toEqual([]);
  });

  it('the allowlist has no stale entries: every listed file exists and still has a big literal radius', () => {
    for (const path of Object.keys(ALLOWLIST)) {
      const file = files.find((f) => f.path === path);
      expect(file, `${path} does not exist any more: remove it from the allowlist`).toBeDefined();
      expect(bigLiteralRadii(file!.source).length, `${path} has no big literal radius any more: remove it from the allowlist`).toBeGreaterThan(0);
      expect(ALLOWLIST[path]!.trim().length, `${path} needs a reason`).toBeGreaterThan(0);
    }
  });

  it('theme/shape.ts imports no React Native (the unit tests above run it in plain Node)', () => {
    const shape = files.find((f) => f.path === 'theme/shape.ts')!;
    expect(shape.source).not.toMatch(/from\s+['"]react-native/);
    expect(shape.source).not.toMatch(/from\s+['"]react['"]/);
  });
});

describe('shape guard: the detectors themselves', () => {
  it('finds big literal radii in every spelling, and leaves small dots, computed radii and comments alone', () => {
    expect(bigLiteralRadii('{ borderRadius: 12 }').map((h) => h.value)).toEqual([12]);
    expect(bigLiteralRadii('borderRadius:16,').map((h) => h.value)).toEqual([16]);
    expect(bigLiteralRadii('borderTopLeftRadius: 8').map((h) => h.value)).toEqual([8]);
    expect(bigLiteralRadii('borderBottomRightRadius : 999').map((h) => h.value)).toEqual([999]);
    expect(bigLiteralRadii('borderRadius: 6').map((h) => h.value)).toEqual([6]);
    expect(bigLiteralRadii('borderRadius: 5')).toEqual([]); // a 10 px dot
    expect(bigLiteralRadii('borderRadius: 2')).toEqual([]);
    expect(bigLiteralRadii('borderRadius: 5.5')).toEqual([]);
    expect(bigLiteralRadii('borderRadius: radius.lg')).toEqual([]);
    expect(bigLiteralRadii('borderRadius: shape.circle(38)')).toEqual([]);
    expect(bigLiteralRadii('borderRadius: size / 2')).toEqual([]);
    expect(bigLiteralRadii('borderBottomLeftRadius: spacing.xs')).toEqual([]);
    expect(bigLiteralRadii('shadowRadius: 12, textShadowRadius: 8')).toEqual([]);
    expect(bigLiteralRadii('// borderRadius: 16\n/* borderRadius: 20 */')).toEqual([]);
  });

  it('reads the names imported from the theme module', () => {
    expect(themeImports("import { radius, spacing, useTheme } from '@/theme';")).toEqual(['radius', 'spacing', 'useTheme']);
    expect(themeImports("import { WIDE_BREAKPOINT, radius as r, type ThemeColors } from '@/theme';")).toEqual(['WIDE_BREAKPOINT', 'radius', 'ThemeColors']);
    expect(themeImports("import type { Corners } from '@/theme/shape';")).toEqual(['Corners']);
    expect(themeImports("import { radius } from '../theme';")).toEqual(['radius']);
    expect(themeImports("import { radius } from 'other-library';")).toEqual([]);
    expect(themeImports("import { radius } from '@/themes';")).toEqual([]);
    expect(
      themeImports(`import {
  radius,
  spacing,
} from '@/theme';`),
    ).toEqual(['radius', 'spacing']);
  });
});
