/**
 * Copy / paste / undo of diary entries (Cronometer-style group and entry menus).
 *
 * Two kinds of tests, both running the app's OWN modules through the `@/` alias:
 *  - pure rules: the row builders, clipboard, target-group resolution, menu rules, group summary, recipe draft, toast
 *  - data layer: the plain async functions (copy a day / group, paste, delete + restore) against the mock backend
 *    through the real supabase-js client, so a query the real database would reject fails here too
 *
 * Skipped when the app's dependencies are not installed.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ANON_KEY, BACKEND_ORIGIN, FIXED_NOW_MS, STORAGE_KEY, TODAY } from './constants';
import { IDS, USER, addDays, buildFixtures } from './fixtures';
import { createMockBackend } from './mock-backend';
import { SEED_SESSION_TTL_SECONDS, buildSession, stableUuid } from './session';

const holder = vi.hoisted(() => ({ client: null as any }));

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: true,
  supabase: new Proxy({}, { get: (_target, prop) => holder.client[prop] }),
}));

const here = dirname(fileURLToPath(import.meta.url));
const appRequire = createRequire(join(here, '..', '..', '..', 'apps', 'app', 'package.json'));

async function loadSupabase(): Promise<{ createClient: (url: string, key: string, options: unknown) => any } | null> {
  try {
    return (await import(pathToFileURL(appRequire.resolve('@supabase/supabase-js')).href)) as never;
  } catch {
    return null;
  }
}

const lib = await loadSupabase();

/** App modules are untyped here on purpose (this package's tsconfig knows nothing about React Native). */
const load = (specifier: string): Promise<any> => import(/* @vite-ignore */ specifier);

function connect(variant: Parameters<typeof buildFixtures>[0] = 'default', signedIn = true) {
  const fx = buildFixtures(variant);
  const backend = createMockBackend(fx.seed);
  const session = buildSession(USER, { nowMs: FIXED_NOW_MS, ttlSeconds: SEED_SESSION_TTL_SECONDS });
  const store = new Map<string, string>(signedIn ? [[STORAGE_KEY, JSON.stringify(session)]] : []);
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const res = backend.handle({ method: req.method, url: req.url, headers, body: init?.body == null ? null : String(init.body) });
    return new Response(res.body === '' || res.status === 204 ? null : res.body, { status: res.status, headers: res.headers });
  };
  holder.client = (lib as NonNullable<typeof lib>).createClient(BACKEND_ORIGIN, ANON_KEY, {
    auth: {
      storage: { getItem: async (k: string) => store.get(k) ?? null, setItem: async (k: string, v: string) => void store.set(k, v), removeItem: async (k: string) => void store.delete(k) },
      autoRefreshToken: false,
      persistSession: true,
      detectSessionInUrl: false,
    },
    global: { fetch: fetchImpl },
  });
  return { backend, fx };
}

const YESTERDAY = addDays(TODAY, -1);
const G = IDS.mealGroup;
const F = IDS.food;
const entriesOf = (backend: ReturnType<typeof connect>['backend'], date: string, group?: string) =>
  backend
    .rows('diary_entries')
    .filter((e) => e.entry_date === date && (group === undefined || e.meal_group_id === group))
    .sort((a, b) => Date.parse(String(a.logged_at)) - Date.parse(String(b.logged_at)));
const sortById = (rows: Record<string, unknown>[]) => rows.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));

const suite = lib ? describe : describe.skip;

// =================================================================================================== pure rules

suite('data/diary-copy.ts: pure rules', () => {
  it('isValidISODate / isPastDate accept real calendar dates only', async () => {
    const { isValidISODate, isPastDate } = await load('@/data/diary-copy');
    for (const ok of ['2026-11-10', '2024-02-29', '1999-12-31']) expect(isValidISODate(ok), ok).toBe(true);
    for (const bad of ['2026-02-31', '2026-2-3', '2026-11-10T12:00', '10.11.2026', '', 'tomorrow', null, undefined, 20261110, '2026-13-01', '2025-02-29'])
      expect(isValidISODate(bad), String(bad)).toBe(false);
    expect(isPastDate('2026-11-09', '2026-11-10')).toBe(true);
    expect(isPastDate('2026-11-10', '2026-11-10')).toBe(false);
    expect(isPastDate('2026-11-11', '2026-11-10')).toBe(false);
    expect(isPastDate('garbage', '2026-11-10')).toBe(false);
  });

  it('toCopyItem keeps valid entries and drops everything that could not be a valid row', async () => {
    const { toCopyItem } = await load('@/data/diary-copy');
    const base = { foodId: F.egg, grams: 100, amount: 2, portionLabel: 'large', note: 'x', mealGroupId: G.breakfast };
    expect(toCopyItem(base)).toEqual({ foodId: F.egg, grams: 100, amount: 2, portionLabel: 'large', note: 'x', mealGroupId: G.breakfast });
    expect(toCopyItem({ ...base, grams: '150.5' })?.grams).toBe(150.5); // numeric columns can arrive as strings
    for (const grams of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 'abc', null, undefined]) expect(toCopyItem({ ...base, grams }), String(grams)).toBeNull();
    expect(toCopyItem({ ...base, foodId: 'not-a-uuid' })).toBeNull();
    expect(toCopyItem({ ...base, foodId: null })).toBeNull();
    // the display amount and its unit only make sense together
    expect(toCopyItem({ ...base, amount: 2, portionLabel: null })).toMatchObject({ amount: null, portionLabel: null });
    expect(toCopyItem({ ...base, amount: 0, portionLabel: 'large' })).toMatchObject({ amount: null, portionLabel: null });
    expect(toCopyItem({ ...base, amount: null, portionLabel: '  ' })).toMatchObject({ amount: null, portionLabel: null });
    expect(toCopyItem({ ...base, note: '' })?.note).toBeNull();
    expect(toCopyItem({ ...base, mealGroupId: 'nope' })?.mealGroupId).toBeNull();
  });

  it('buildCopyRows: new rows with source copy, the signed-in user, a kept order, invalid items left out', async () => {
    const { buildCopyRows } = await load('@/data/diary-copy');
    const items = [
      { foodId: F.egg, grams: 100, amount: 2, portionLabel: 'large', note: null, mealGroupId: G.breakfast },
      { foodId: F.oats, grams: 0, amount: null, portionLabel: null, note: null }, // invalid: dropped
      { foodId: F.coffee, grams: 237, amount: 1, portionLabel: 'cup', note: 'black', mealGroupId: G.lunch },
    ];
    const rows = buildCopyRows({ userId: USER.id, toDate: TODAY, items, now: Date.UTC(2026, 10, 10, 11, 0, 0) });
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => r.food_id)).toEqual([F.egg, F.coffee]);
    for (const r of rows) {
      expect(r).toMatchObject({ user_id: USER.id, entry_date: TODAY, source: 'copy' });
      expect(r).not.toHaveProperty('id'); // always a NEW entry
      expect(r.grams).toBeGreaterThan(0);
    }
    expect(rows.map((r: any) => r.meal_group_id)).toEqual([G.breakfast, G.lunch]); // each item keeps its own group
    expect(rows[0]).toMatchObject({ amount: 2, portion_label: 'large', note: null });
    // logged_at is strictly increasing, 1 ms apart: the source order survives the round trip
    expect(rows.map((r: any) => r.logged_at)).toEqual(['2026-11-10T11:00:00.000Z', '2026-11-10T11:00:00.001Z']);

    const forced = buildCopyRows({ userId: USER.id, toDate: TODAY, items, mealGroupId: G.dinner });
    expect(forced.map((r: any) => r.meal_group_id)).toEqual([G.dinner, G.dinner]);
    expect(buildCopyRows({ userId: USER.id, toDate: TODAY, items, mealGroupId: null }).map((r: any) => r.meal_group_id)).toEqual([null, null]);
    expect(buildCopyRows({ userId: USER.id, toDate: TODAY, items: [] })).toEqual([]);
  });

  it('buildCopyRows refuses an invalid user, date or target group (nothing may be written)', async () => {
    const { buildCopyRows } = await load('@/data/diary-copy');
    const items = [{ foodId: F.egg, grams: 100, amount: null, portionLabel: null, note: null }];
    expect(() => buildCopyRows({ userId: '', toDate: TODAY, items })).toThrow(/signed out/i);
    expect(() => buildCopyRows({ userId: 'someone', toDate: TODAY, items })).toThrow(/signed out/i);
    for (const toDate of ['2026-02-31', 'tomorrow', '', '2026-11-1']) expect(() => buildCopyRows({ userId: USER.id, toDate, items }), toDate).toThrow(/invalid date/i);
    expect(() => buildCopyRows({ userId: USER.id, toDate: TODAY, items, mealGroupId: 'breakfast' })).toThrow(/meal group/i);
  });

  it('resolveTargetGroup: the preferred group when it exists, else the fallback, else the first visible group', async () => {
    const { resolveTargetGroup } = await load('@/data/diary-copy');
    const groups = [
      { id: 'g0', hidden: true },
      { id: 'g1', hidden: false },
      { id: 'g2', hidden: false },
    ];
    expect(resolveTargetGroup('g2', groups)).toBe('g2');
    expect(resolveTargetGroup('g0', groups)).toBe('g0'); // a hidden group that has entries is still a valid target
    expect(resolveTargetGroup('gone', groups)).toBe('g1');
    expect(resolveTargetGroup(null, groups, 'g2')).toBe('g2');
    expect(resolveTargetGroup('gone', groups, 'g2')).toBe('g2');
    expect(resolveTargetGroup(undefined, groups, 'also-gone')).toBe('g1');
    expect(resolveTargetGroup('g2', [])).toBe('g2'); // groups not loaded yet: trust the caller
    expect(resolveTargetGroup(null, [])).toBeNull();
    expect(resolveTargetGroup(null, [{ id: 'only', hidden: true }])).toBe('only');
  });

  it('makeClipboard keeps the pasteable items; pasteLabel names the paste action after what it holds', async () => {
    const { makeClipboard, pasteLabel } = await load('@/data/diary-copy');
    const entry = (over: Record<string, unknown> = {}) => ({
      foodId: F.egg,
      grams: 100,
      amount: 2,
      portionLabel: 'large',
      note: null,
      mealGroupId: G.breakfast,
      food: { name: 'Egg', brand: null },
      ...over,
    });
    const clip = makeClipboard({ kind: 'group', label: 'Breakfast', sourceDate: TODAY, sourceGroupId: G.breakfast, entries: [entry(), entry({ grams: 0 }), entry({ foodId: F.oats, food: { name: 'Oats', brand: 'Acme' } })] });
    expect(clip).toMatchObject({ kind: 'group', label: 'Breakfast', sourceDate: TODAY, sourceGroupId: G.breakfast });
    expect(clip.items.map((i: any) => [i.name, i.brand, i.grams])).toEqual([['Egg', null, 100], ['Oats', 'Acme', 100]]);
    expect(pasteLabel(clip)).toBe('Paste Group');
    const single = makeClipboard({ kind: 'entry', label: 'Egg', sourceDate: TODAY, sourceGroupId: null, entries: [entry()] });
    expect(single.items).toHaveLength(1);
    expect(pasteLabel(single)).toBe('Paste Entry');
    expect(makeClipboard({ kind: 'group', label: 'Empty', sourceDate: TODAY, sourceGroupId: null, entries: [] })).toBeNull();
    expect(makeClipboard({ kind: 'entry', label: 'Bad', sourceDate: TODAY, sourceGroupId: null, entries: [entry({ grams: -1 })] })).toBeNull();
  });

  it('sortEntriesByTime orders by the time logged, newest first on request, and is stable', async () => {
    const { sortEntriesByTime } = await load('@/data/diary-copy');
    const list = [
      { id: 'c', loggedAt: '2026-11-10T09:00:00+00:00' },
      { id: 'a', loggedAt: '2026-11-10T07:00:00+00:00' },
      { id: 'b', loggedAt: '2026-11-10T07:00:00+00:00' },
      { id: 'd', loggedAt: 'garbage' },
    ];
    expect(sortEntriesByTime(list).map((e: any) => e.id)).toEqual(['d', 'a', 'b', 'c']);
    expect(sortEntriesByTime(list, true).map((e: any) => e.id)).toEqual(['c', 'b', 'a', 'd']);
    expect(list.map((e) => e.id)).toEqual(['c', 'a', 'b', 'd']); // the input is not mutated
  });

  it('buildRestoreRows forces the signed-in user and leaves out rows that could not be valid', async () => {
    const { buildRestoreRows } = await load('@/data/diary-copy');
    const row = (over: Record<string, unknown> = {}) => ({
      id: stableUuid('r'),
      user_id: stableUuid('other-user'),
      entry_date: TODAY,
      meal_group_id: G.lunch,
      food_id: F.egg,
      grams: '120',
      amount: null,
      portion_label: null,
      source: 'manual',
      ai_confidence: null,
      note: null,
      logged_at: '2026-11-10T08:00:00+00:00',
      ...over,
    });
    const rows = buildRestoreRows([row(), row({ id: 'bad' }), row({ grams: 0 }), row({ entry_date: '2026-02-31' }), row({ food_id: 'x' }), row({ meal_group_id: 'gone' })], USER.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r: any) => r.user_id === USER.id)).toBe(true);
    expect(rows[0].grams).toBe(120);
    expect(rows[1].meal_group_id).toBeNull();
    expect(() => buildRestoreRows([row()], 'nobody')).toThrow(/signed out/i);
  });
});

suite('components/diary/copy-menus.ts: which actions each menu offers', () => {
  const group = {
    name: 'Breakfast',
    hasGroup: true,
    entryCount: 3,
    yesterdayCount: 2,
    isPastDate: false,
    clipboard: null,
    collapsed: false,
    newestFirst: false,
  };

  it('a group with entries on today offers add / saved meal / copy yesterday / copy / recipe / meal / summary / sort / delete', async () => {
    const { groupMenuItems } = await load('@/components/diary/copy-menus');
    const items = groupMenuItems(group);
    expect(items.map((i: any) => i.key)).toEqual([
      'add',
      'add-saved-meal',
      'copy-yesterday',
      'copy-group',
      'copy-from-day',
      'create-recipe',
      'create-meal',
      'nutrition-summary',
      'sort-time',
      'collapse',
      'delete',
    ]);
    const labels = items.map((i: any) => i.label);
    expect(labels).toContain('Add food to Breakfast');
    expect(labels).toContain('Add a saved meal to Breakfast...'); // moved here from the header (one + and one ... there)
    expect(labels).toContain("Copy Yesterday's Group");
    expect(labels).toContain('Copy Group');
    expect(labels).toContain('Create Recipe from Group');
    expect(labels).toContain('Create Meal from Group');
    expect(labels).toContain('Show Nutrition Summary');
    expect(labels).toContain('Delete group entries');
    expect(labels).not.toContain('Copy to Today'); // only on a past date
    expect(labels).not.toContain('Paste Group'); // empty clipboard
    expect(items.find((i: any) => i.key === 'delete')?.destructive).toBe(true);
    expect(items.filter((i: any) => i.destructive)).toHaveLength(1);
  });

  it("hides Copy Yesterday's Group when yesterday's group is empty", async () => {
    const { groupMenuItems } = await load('@/components/diary/copy-menus');
    expect(groupMenuItems({ ...group, yesterdayCount: 0 }).map((i: any) => i.key)).not.toContain('copy-yesterday');
  });

  it('Copy to Today only on a past date and only when the group has entries', async () => {
    const { groupMenuItems } = await load('@/components/diary/copy-menus');
    expect(groupMenuItems({ ...group, isPastDate: true }).map((i: any) => i.label)).toContain('Copy to Today');
    expect(groupMenuItems({ ...group, isPastDate: true, entryCount: 0 }).map((i: any) => i.label)).not.toContain('Copy to Today');
  });

  it('Paste appears with a clipboard and is named after what it holds', async () => {
    const { groupMenuItems } = await load('@/components/diary/copy-menus');
    expect(groupMenuItems({ ...group, clipboard: { kind: 'group' } }).map((i: any) => i.label)).toContain('Paste Group');
    expect(groupMenuItems({ ...group, clipboard: { kind: 'entry' } }).map((i: any) => i.label)).toContain('Paste Entry');
    // pasting works into an EMPTY group too
    expect(groupMenuItems({ ...group, entryCount: 0, clipboard: { kind: 'group' } }).map((i: any) => i.key)).toContain('paste');
  });

  it('an empty group has nothing to copy, summarise, sort or delete; one entry has nothing to sort', async () => {
    const { groupMenuItems } = await load('@/components/diary/copy-menus');
    expect(groupMenuItems({ ...group, entryCount: 0 }).map((i: any) => i.key)).toEqual(['add', 'add-saved-meal', 'copy-yesterday', 'copy-from-day', 'collapse']);
    const one = groupMenuItems({ ...group, entryCount: 1 }).map((i: any) => i.key);
    expect(one).not.toContain('sort-time');
    expect(one).toContain('delete');
  });

  it('the "Other" bucket (entries without a meal group) offers no group-bound actions', async () => {
    const { groupMenuItems } = await load('@/components/diary/copy-menus');
    const keys = groupMenuItems({ ...group, name: 'Other', hasGroup: false, clipboard: { kind: 'group' }, isPastDate: true }).map((i: any) => i.key);
    expect(keys).toEqual(['copy-group', 'create-recipe', 'create-meal', 'nutrition-summary', 'sort-time', 'collapse', 'delete']);
  });

  it('labels follow the state (collapse / expand, sort direction)', async () => {
    const { groupMenuItems } = await load('@/components/diary/copy-menus');
    const labels = (over: object) => groupMenuItems({ ...group, ...over }).map((i: any) => i.label);
    expect(labels({})).toContain('Collapse Breakfast');
    expect(labels({ collapsed: true })).toContain('Expand Breakfast');
    expect(labels({})).toContain('Sort by Time: newest first');
    expect(labels({ newestFirst: true })).toContain('Sort by Time: oldest first');
  });

  it("the date menu offers Copy yesterday's entire diary only when yesterday has entries", async () => {
    const { dateMenuItems } = await load('@/components/diary/copy-menus');
    const base = { isToday: true, yesterdayCount: 12, sectionCount: 4, allCollapsed: false };
    expect(dateMenuItems(base).map((i: any) => i.label)).toEqual(["Copy yesterday's entire diary", 'Copy a day from...', 'Collapse all meals']);
    expect(dateMenuItems({ ...base, yesterdayCount: 0 }).map((i: any) => i.label)).toEqual(['Copy a day from...', 'Collapse all meals']);
    expect(dateMenuItems({ ...base, isToday: false, allCollapsed: true }).map((i: any) => i.label)).toEqual([
      'Go to today',
      "Copy yesterday's entire diary",
      'Copy a day from...',
      'Expand all meals',
    ]);
  });

  it('the entry sheet offers Copy Entry always, Paste with a clipboard and Copy to Today on a past date', async () => {
    const { entryCopyActions } = await load('@/components/diary/copy-menus');
    expect(entryCopyActions({ isPastDate: false, clipboard: null })).toEqual({ copy: 'Copy Entry', paste: null, copyToToday: null });
    expect(entryCopyActions({ isPastDate: true, clipboard: { kind: 'entry' } })).toEqual({ copy: 'Copy Entry', paste: 'Paste Entry', copyToToday: 'Copy to Today' });
    expect(entryCopyActions({ isPastDate: false, clipboard: { kind: 'group' } }).paste).toBe('Paste Group');
  });
});

suite('components/diary/group-summary.ts: nutrition summary of a meal group', () => {
  it('sums the per-entry nutrients; a nutrient without data stays unknown; partial data is flagged', async () => {
    const { buildGroupSummary } = await load('@/components/diary/group-summary');
    const entries = [
      { nutrients: { ENERGY_KCAL: 300, PROTEIN_G: 20, CARBS_G: 30, NET_CARBS_G: 25, FIBER_G: 5, FAT_G: 10, SODIUM_MG: 200, VITAMIN_C_MG: 10 } },
      { nutrients: { ENERGY_KCAL: 100, PROTEIN_G: 5, CARBS_G: 12, NET_CARBS_G: 12, FAT_G: 2, SODIUM_MG: 100 } },
    ];
    const net = buildGroupSummary(entries, true);
    expect(net.count).toBe(2);
    expect(net.headline.map((h: any) => [h.key, h.label, h.amount])).toEqual([
      ['energy', 'Energy', 400],
      ['protein', 'Protein', 25],
      ['carbs', 'Net Carbs', 37],
      ['fat', 'Fat', 12],
    ]);
    expect(buildGroupSummary(entries, false).headline.find((h: any) => h.key === 'carbs')).toMatchObject({ label: 'Carbs', amount: 42 });

    const rows = Object.fromEntries(net.sections.flatMap((s: any) => s.rows).map((r: any) => [r.code, r]));
    expect(rows.SODIUM_MG).toMatchObject({ amount: 300, unit: 'mg', incomplete: false });
    expect(rows.FIBER_G).toMatchObject({ amount: 5, incomplete: true }); // only the first entry has fiber: a lower bound
    expect(rows.VITAMIN_C_MG).toMatchObject({ amount: 10, incomplete: true });
    expect(rows.CALCIUM_MG).toBeUndefined(); // unknown is not listed as 0
    expect(net.incompleteNutrients).toEqual(expect.arrayContaining(['FIBER_G', 'VITAMIN_C_MG']));
    expect(net.sections.map((s: any) => s.key)).toEqual(['carbs', 'vitamins', 'minerals']);
  });

  it('is exactly the sum of the entries and an empty group has unknown (not zero) headline values', async () => {
    const { buildGroupSummary } = await load('@/components/diary/group-summary');
    const { sumNutrients } = await import('../../../packages/core/src');
    const entries = [{ nutrients: { ENERGY_KCAL: 120.5, FAT_G: 3.25 } }, { nutrients: { ENERGY_KCAL: 79.5, FAT_G: 1.75 } }, { nutrients: {} }];
    expect(buildGroupSummary(entries, true).totals).toEqual(sumNutrients(entries.map((e) => e.nutrients)));
    const empty = buildGroupSummary([], true);
    expect(empty.count).toBe(0);
    expect(empty.headline.every((h: any) => h.amount === undefined)).toBe(true);
    expect(empty.sections).toEqual([]);
  });
});

suite('state/recipe-draft.ts + state/diary-toast.ts', () => {
  it('buildRecipeDraft: one ingredient per valid entry in grams, null when nothing is left', async () => {
    const { buildRecipeDraft } = await load('@/state/recipe-draft');
    const e = (foodId: string, grams: number, name: string, brand: string | null = null) => ({ foodId, grams, food: { name, brand } });
    expect(buildRecipeDraft('Breakfast recipe', [e(F.egg, 100, 'Egg'), e(F.oats, 0, 'Oats'), e(F.coffee, 237.5, 'Coffee', 'Acme')])).toEqual({
      name: 'Breakfast recipe',
      ingredients: [
        { foodId: F.egg, name: 'Egg', brand: null, grams: 100 },
        { foodId: F.coffee, name: 'Coffee', brand: 'Acme', grams: 237.5 },
      ],
    });
    expect(buildRecipeDraft('x', [])).toBeNull();
    expect(buildRecipeDraft('x', [e(F.egg, -1, 'Egg')])).toBeNull();
  });

  describe('toast', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(async () => {
      const { dismissDiaryToast } = await load('@/state/diary-toast');
      dismissDiaryToast();
      vi.useRealTimers();
    });

    it('shows a toast with an action for 8 s; a newer toast replaces it and the old timer cannot close the new one', async () => {
      const { showDiaryToast, dismissDiaryToast, useDiaryToast } = await load('@/state/diary-toast');
      const undo = vi.fn();
      const first = showDiaryToast({ message: 'Copied 4 items to Breakfast', action: { label: 'Undo', onPress: undo } });
      expect(useDiaryToast.getState().toast).toMatchObject({ id: first, message: 'Copied 4 items to Breakfast', tone: 'success' });
      expect(useDiaryToast.getState().toast.action.label).toBe('Undo');
      vi.advanceTimersByTime(7_900);
      expect(useDiaryToast.getState().toast?.id).toBe(first);

      const second = showDiaryToast({ message: 'Undone', durationMs: 2_500 });
      expect(second).not.toBe(first);
      vi.advanceTimersByTime(200); // the first toast's timer was cancelled: it cannot close the newer one
      expect(useDiaryToast.getState().toast?.id).toBe(second);
      vi.advanceTimersByTime(2_400);
      expect(useDiaryToast.getState().toast).toBeNull();

      const third = showDiaryToast({ message: 'x' });
      dismissDiaryToast(first); // a stale id does nothing
      expect(useDiaryToast.getState().toast?.id).toBe(third);
      dismissDiaryToast(third);
      expect(useDiaryToast.getState().toast).toBeNull();
    });

    it('errors stay 6 s, plain toasts 4 s', async () => {
      const { showDiaryToast, useDiaryToast } = await load('@/state/diary-toast');
      showDiaryToast({ message: 'boom', tone: 'error' });
      vi.advanceTimersByTime(5_900);
      expect(useDiaryToast.getState().toast?.tone).toBe('error');
      vi.advanceTimersByTime(200);
      expect(useDiaryToast.getState().toast).toBeNull();
      showDiaryToast({ message: 'ok' });
      vi.advanceTimersByTime(4_100);
      expect(useDiaryToast.getState().toast).toBeNull();
    });
  });
});

// =================================================================================================== data layer

suite('data/diary-copy.ts against the mock backend', () => {
  it("copyFromDay: Copy Yesterday's Group adds yesterday's breakfast to today's breakfast as NEW source=copy rows", async () => {
    const { copyFromDay } = await load('@/data/diary-copy');
    const { backend } = connect();
    const foodsBefore = structuredClone(backend.rows('foods'));
    const sourceRows = entriesOf(backend, YESTERDAY, G.breakfast);
    const todayBefore = entriesOf(backend, TODAY, G.breakfast);
    expect(sourceRows).toHaveLength(3);

    // `now` after everything the fixtures logged today, so "sorts after the existing entries" does not depend on the clock
    const outcome = await copyFromDay({ fromDate: YESTERDAY, toDate: TODAY, fromMealGroupId: G.breakfast }, FIXED_NOW_MS);
    expect(outcome).toMatchObject({ count: 3, toDate: TODAY, skipped: 0 });
    expect(outcome.ids).toHaveLength(3);

    const after = entriesOf(backend, TODAY, G.breakfast);
    expect(after).toHaveLength(todayBefore.length + 3);
    const created = after.filter((e) => outcome.ids.includes(e.id));
    expect(created).toHaveLength(3);
    for (const [i, row] of created.entries()) {
      const src = sourceRows[i] as Record<string, unknown>;
      expect(row).toMatchObject({
        user_id: USER.id,
        entry_date: TODAY,
        meal_group_id: G.breakfast,
        food_id: src.food_id,
        grams: src.grams,
        amount: src.amount,
        portion_label: src.portion_label,
        source: 'copy',
      });
      expect(row.id).not.toBe(src.id);
    }
    // the copies sort after what was already in the group, in the source order
    expect(after.slice(-3).map((e) => e.id)).toEqual(created.map((e) => e.id));
    // the source day and the foods are untouched
    expect(entriesOf(backend, YESTERDAY, G.breakfast)).toEqual(sourceRows);
    expect(backend.rows('foods')).toEqual(foodsBefore);
    expect(backend.mutations.filter((m) => !m.ok)).toEqual([]);
    expect(backend.integrityErrors()).toEqual([]);
    expect(backend.unhandled).toEqual([]);
    // the dashboard cache (daily_totals) follows
    expect(backend.rows('daily_totals').find((t) => t.entry_date === TODAY)?.entry_count).toBe(15 + 3);
  });

  it('copyFromDay: Copy to Today puts a past day\'s group into today\'s same group', async () => {
    const { copyFromDay } = await load('@/data/diary-copy');
    const { backend } = connect();
    const outcome = await copyFromDay({ fromDate: YESTERDAY, toDate: TODAY, fromMealGroupId: G.snacks });
    expect(outcome.count).toBe(4);
    const created = backend.rows('diary_entries').filter((e) => outcome.ids.includes(e.id));
    expect(created.every((e) => e.entry_date === TODAY && e.meal_group_id === G.snacks && e.source === 'copy')).toBe(true);
    // an AI estimate keeps its note on the copy, the confidence belongs to the original logging and is not copied
    expect(created.find((e) => e.food_id === F.burekAi)).toMatchObject({ note: 'AI estimate from the description', grams: 100, ai_confidence: null });
  });

  it("copyFromDay: copy yesterday's entire diary keeps every meal group", async () => {
    const { copyFromDay } = await load('@/data/diary-copy');
    const { backend } = connect();
    const target = addDays(TODAY, 1); // an empty day
    const outcome = await copyFromDay({ fromDate: YESTERDAY, toDate: target });
    expect(outcome.count).toBe(12);
    const created = entriesOf(backend, target);
    expect(created).toHaveLength(12);
    const group = (id: string) => created.filter((e) => e.meal_group_id === id).length;
    expect([group(G.breakfast), group(G.lunch), group(G.dinner), group(G.snacks)]).toEqual([3, 1, 4, 4]);
    // the day keeps its order across groups
    expect(created.map((e) => e.food_id)).toEqual(entriesOf(backend, YESTERDAY).map((e) => e.food_id));
    expect(backend.integrityErrors()).toEqual([]);
  });

  it('copyFromDay: an empty source writes nothing; the same day, a bad date and a signed-out user are refused', async () => {
    const { copyFromDay } = await load('@/data/diary-copy');
    const { backend } = connect();
    const empty = await copyFromDay({ fromDate: addDays(TODAY, -30), toDate: TODAY });
    expect(empty).toEqual({ count: 0, ids: [], toDate: TODAY, skipped: 0 });
    await expect(copyFromDay({ fromDate: TODAY, toDate: TODAY })).rejects.toThrow(/different day/i);
    await expect(copyFromDay({ fromDate: '2026-02-31', toDate: TODAY })).rejects.toThrow(/invalid date/i);
    await expect(copyFromDay({ fromDate: YESTERDAY, toDate: 'tomorrow' })).rejects.toThrow(/invalid date/i);
    expect(backend.mutationsOf('diary_entries', 'insert')).toEqual([]);

    const out = connect('default', false);
    await expect(copyFromDay({ fromDate: YESTERDAY, toDate: TODAY })).rejects.toThrow('You are signed out. Please sign in again.');
    expect(out.backend.mutations).toEqual([]);
  });

  it('pasteItems: a group clipboard lands in the chosen group, twice if pasted twice; invalid items are skipped', async () => {
    const { pasteItems, makeClipboard } = await load('@/data/diary-copy');
    const { backend } = connect();
    const clip = makeClipboard({
      kind: 'group',
      label: 'Breakfast',
      sourceDate: YESTERDAY,
      sourceGroupId: G.breakfast,
      entries: entriesOf(backend, YESTERDAY, G.breakfast).map((r) => ({
        foodId: r.food_id,
        grams: r.grams,
        amount: r.amount,
        portionLabel: r.portion_label,
        note: r.note,
        mealGroupId: r.meal_group_id,
        food: { name: String(r.food_id), brand: null },
      })),
    });
    const dinnerBefore = entriesOf(backend, TODAY, G.dinner).length;
    const first = await pasteItems({ items: clip.items, toDate: TODAY, toMealGroupId: G.dinner });
    const second = await pasteItems({ items: [...clip.items, { foodId: F.egg, grams: -3, amount: null, portionLabel: null, note: null }], toDate: TODAY, toMealGroupId: G.dinner });
    expect(first).toMatchObject({ count: 3, skipped: 0 });
    expect(second).toMatchObject({ count: 3, skipped: 1 });
    expect(entriesOf(backend, TODAY, G.dinner)).toHaveLength(dinnerBefore + 6);
    expect(entriesOf(backend, TODAY, G.breakfast).filter((e) => e.source === 'copy')).toHaveLength(0); // the source group is untouched
    expect(backend.rows('diary_entries').every((e) => Number(e.grams) > 0)).toBe(true);
    expect(backend.mutations.filter((m) => !m.ok)).toEqual([]);
  });

  it('pasteItems: an entry clipboard works into a past date; an invalid target date or meal group writes nothing', async () => {
    const { pasteItems } = await load('@/data/diary-copy');
    const { backend } = connect();
    const item = { foodId: F.apple, grams: 182, amount: 1, portionLabel: 'medium (3" dia)', note: null };
    const past = addDays(TODAY, -3);
    const outcome = await pasteItems({ items: [item], toDate: past, toMealGroupId: G.snacks });
    expect(outcome.count).toBe(1);
    expect(backend.rows('diary_entries').find((e) => e.id === outcome.ids[0])).toMatchObject({ entry_date: past, meal_group_id: G.snacks, grams: 182, amount: 1, source: 'copy', user_id: USER.id });

    const before = backend.rows('diary_entries').length;
    await expect(pasteItems({ items: [item], toDate: '2026-02-31', toMealGroupId: G.snacks })).rejects.toThrow(/invalid date/i);
    await expect(pasteItems({ items: [item], toDate: TODAY, toMealGroupId: 'snacks' })).rejects.toThrow(/meal group/i);
    expect((await pasteItems({ items: [{ ...item, grams: 0 }], toDate: TODAY, toMealGroupId: G.snacks })).count).toBe(0);
    expect(backend.rows('diary_entries')).toHaveLength(before);
  });

  it('pasteItems: a group the user does not own is rejected by the database, not silently accepted', async () => {
    const { pasteItems } = await load('@/data/diary-copy');
    const { backend } = connect();
    const item = { foodId: F.apple, grams: 182, amount: null, portionLabel: null, note: null };
    await expect(pasteItems({ items: [item], toDate: TODAY, toMealGroupId: stableUuid('someone-elses-group') })).rejects.toMatchObject({ code: '23503' });
    expect(backend.rows('diary_entries').filter((e) => e.source === 'copy')).toHaveLength(0);
  });

  it('Undo of a copy: deleting the inserted ids restores the exact previous state', async () => {
    const { copyFromDay, deleteEntries } = await load('@/data/diary-copy');
    const { backend } = connect();
    const before = sortById(structuredClone(backend.rows('diary_entries')));
    const outcome = await copyFromDay({ fromDate: YESTERDAY, toDate: TODAY });
    expect(backend.rows('diary_entries')).toHaveLength(before.length + 12);
    const removed = await deleteEntries(outcome.ids);
    expect(removed).toHaveLength(12);
    expect(sortById(backend.rows('diary_entries'))).toEqual(before);
    expect(backend.integrityErrors()).toEqual([]);
    expect(backend.rows('daily_totals').find((t) => t.entry_date === TODAY)?.entry_count).toBe(15);
  });

  it('deleteEntries + restoreEntries: Delete group entries then Undo puts back identical rows', async () => {
    const { deleteEntries, restoreEntries } = await load('@/data/diary-copy');
    const { backend } = connect();
    const before = sortById(structuredClone(backend.rows('diary_entries')));
    const group = entriesOf(backend, YESTERDAY, G.snacks);
    expect(group).toHaveLength(4);
    expect(group.some((e) => e.ai_confidence !== null && e.source === 'ai_text')).toBe(true); // an AI entry: every column must survive

    const deleted = await deleteEntries(group.map((e) => e.id));
    expect(deleted.map((r: any) => r.id).sort()).toEqual(group.map((e) => e.id).sort());
    expect(backend.mutationsOf('diary_entries', 'delete')).toMatchObject([{ rows: 4, ok: true }]); // what the UI scenarios assert
    expect(entriesOf(backend, YESTERDAY, G.snacks)).toEqual([]);
    expect(entriesOf(backend, YESTERDAY)).toHaveLength(8); // the other groups of that day are untouched
    expect(backend.rows('daily_totals').find((t) => t.entry_date === YESTERDAY)?.entry_count).toBe(8);

    const restored = await restoreEntries(deleted);
    expect(restored.sort()).toEqual(group.map((e) => e.id).sort());
    expect(sortById(backend.rows('diary_entries'))).toEqual(before);
    expect(backend.rows('daily_totals').find((t) => t.entry_date === YESTERDAY)?.entry_count).toBe(12);
    expect(backend.mutations.filter((m) => !m.ok)).toEqual([]);
    expect(backend.integrityErrors()).toEqual([]);
    expect(backend.unhandled).toEqual([]);
  });

  it('deleteEntries ignores unknown, invalid and duplicate ids; delete and restore refuse a signed-out user', async () => {
    const { deleteEntries, restoreEntries } = await load('@/data/diary-copy');
    const { backend } = connect();
    const someone = stableUuid('someone-else');
    const before = backend.rows('diary_entries').length;
    expect(await deleteEntries([])).toEqual([]);
    expect(await deleteEntries(['nope', someone, IDS.missing])).toEqual([]);
    expect(backend.rows('diary_entries')).toHaveLength(before);
    const target = entriesOf(backend, TODAY, G.lunch)[0] as Record<string, unknown>;
    const rows = await deleteEntries([target.id, target.id, 'nope']);
    expect(rows).toHaveLength(1);
    expect(backend.rows('diary_entries')).toHaveLength(before - 1);

    const out = connect('default', false);
    await expect(restoreEntries(rows)).rejects.toThrow('You are signed out. Please sign in again.');
    await expect(deleteEntries([target.id])).rejects.toThrow('You are signed out. Please sign in again.');
    expect(out.backend.mutations).toEqual([]);
  });

  it('restoreEntries refuses rows that are no longer valid and rewrites a foreign user id to the signed-in user', async () => {
    const { deleteEntries, restoreEntries } = await load('@/data/diary-copy');
    const { backend } = connect();
    const target = entriesOf(backend, TODAY, G.lunch)[0] as Record<string, unknown>;
    const [row] = await deleteEntries([target.id]);
    const ids = await restoreEntries([{ ...row, user_id: stableUuid('someone-else') }, { ...row, id: stableUuid('x'), grams: 0 }]);
    expect(ids).toEqual([target.id]);
    expect(backend.rows('diary_entries').find((e) => e.id === target.id)?.user_id).toBe(USER.id);
    expect(backend.rows('diary_entries').filter((e) => e.id === stableUuid('x'))).toEqual([]);
  });
});
