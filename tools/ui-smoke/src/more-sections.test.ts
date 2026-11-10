/**
 * The More screen's section model (apps/app/src/components/settings/more-sections.ts): which sections there are, in which order,
 * which rows each holds and that every row leads to a real screen. The More screen is a phone's fourth tab; a desktop window lists
 * the same rows in its sidebar (see desktop-shell.test.ts). Pure Node: the screens themselves are covered by the browser smoke
 * scenarios `more`, `more: sign out`, `shell: ...` and the Workouts ones.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildMoreSections, type MoreRow } from '../../../apps/app/src/components/settings/more-sections';
import { scanRoutes } from './routes-scan';

const APP_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'apps', 'app', 'src');
const APP_DIR = join(APP_SRC, 'app');

const labels = (aiEnabled: boolean) => buildMoreSections({ aiEnabled }).map((s) => s.label);
const rowsOf = (aiEnabled: boolean): MoreRow[] => buildMoreSections({ aiEnabled }).flatMap((s) => s.rows);

describe('More sections', () => {
  it.each([true, false])('lists the six sections in the same order (AI enabled: %s)', (aiEnabled) => {
    expect(labels(aiEnabled)).toEqual(['Training', 'Coach', 'Profile', 'Connections', 'App', 'Account']);
    expect(buildMoreSections({ aiEnabled }).map((s) => s.id)).toEqual(['training', 'coach', 'profile', 'connections', 'app', 'account']);
  });

  it('puts the rows in their sections, in order', () => {
    const rows = (aiEnabled: boolean) =>
      Object.fromEntries(buildMoreSections({ aiEnabled }).map((s) => [s.id, s.rows.map((r) => r.label)]));
    expect(rows(true)).toEqual({
      training: ['Workouts'],
      coach: ['Coach', 'AI Coach & keys'],
      profile: ['Profile & targets', 'Personal details', 'Nutrient targets'],
      connections: ['Connected apps & devices'],
      app: ['Display & units', 'About'],
      account: [],
    });
    expect(rows(false)).toEqual({ ...rows(true), coach: ['AI (optional)'] });
  });

  it('shows the Coach row only when the AI gate is open, and says so on the AI row', () => {
    expect(rowsOf(true).map((r) => r.label)).toContain('Coach');
    expect(rowsOf(false).map((r) => r.label)).not.toContain('Coach');
    expect(rowsOf(false).map((r) => r.label)).not.toContain('AI Coach & keys');
    expect(rowsOf(true).find((r) => r.id === 'ai')).toMatchObject({ label: 'AI Coach & keys', badge: 'On', href: '/settings/ai' });
    expect(rowsOf(false).find((r) => r.id === 'ai')).toMatchObject({ label: 'AI (optional)', badge: 'Off', href: '/settings/ai' });
  });

  it('keeps Workouts listed without an AI key', () => {
    for (const aiEnabled of [true, false]) {
      expect(rowsOf(aiEnabled).find((r) => r.label === 'Workouts')?.href).toBe('/workouts');
    }
    // The same path as the constant the Workouts screens use (read as text: links.ts imports expo-router types).
    const links = readFileSync(join(APP_SRC, 'components', 'workouts', 'links.ts'), 'utf8');
    expect(links).toMatch(/WORKOUTS_HREF\s*=\s*'\/workouts'/);
  });

  it('has no status text except on the AI row (nothing that would need a query)', () => {
    for (const aiEnabled of [true, false]) {
      expect(rowsOf(aiEnabled).filter((r) => r.badge !== undefined).map((r) => r.id)).toEqual(['ai']);
    }
  });

  it('has no duplicate labels, ids or routes, and the account section has no rows', () => {
    for (const aiEnabled of [true, false]) {
      const rows = rowsOf(aiEnabled);
      expect(new Set(rows.map((r) => r.label)).size).toBe(rows.length);
      expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
      expect(new Set(rows.map((r) => r.href)).size).toBe(rows.length);
      expect(buildMoreSections({ aiEnabled }).find((s) => s.id === 'account')?.rows).toEqual([]);
    }
  });

  it('repeats a section label as a row label only for the Coach row (the browser smoke finds both by their text)', () => {
    for (const aiEnabled of [true, false]) {
      const sectionLabels = labels(aiEnabled);
      expect(rowsOf(aiEnabled).filter((r) => sectionLabels.includes(r.label)).map((r) => r.label)).toEqual(aiEnabled ? ['Coach'] : []);
    }
  });

  it('gives every row a description, a path and a symbol for iOS, Android and the web', () => {
    for (const row of rowsOf(true)) {
      expect(row.description.length, row.label).toBeGreaterThan(10);
      expect(row.href, row.label).toMatch(/^\/[a-z][a-z/-]*$/);
      for (const platform of ['ios', 'android', 'web'] as const) expect(row.symbol[platform], `${row.label} ${platform}`).toMatch(/^[a-z0-9_.]+$/);
    }
  });

  it('uses the new description of Display & units', () => {
    expect(rowsOf(true).find((r) => r.label === 'Display & units')?.description).toBe(
      'Colour theme, light or dark mode, metric or imperial units',
    );
  });

  it('leads every row to a screen that exists', () => {
    const routes = new Set(scanRoutes(APP_DIR).map((r) => r.pattern));
    for (const row of rowsOf(true)) expect(routes.has(row.href), `${row.label} -> ${row.href}`).toBe(true);
  });
});
