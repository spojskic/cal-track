/**
 * The flat diary (Cronometer style): the rules behind what the rows, bars and swipe-to-delete show.
 *
 *  - pure rules, run through the app's own modules via the `@/` alias: macro bar maths and the percentage colour, the
 *    text of food / exercise / biometric / note rows, the full-swipe line and the screen reader delete action, which
 *    rows can be swiped away and what Undo writes back
 *  - the delete + Undo of an exercise / biometric / note row against the mock backend through the real supabase-js
 *    client, so a column the real database would reject fails here too
 *
 * The swipe itself needs a touch device (react-native-gesture-handler is not part of the web build), so it cannot be
 * clicked in the browser run; the web run covers the same rows and the entry sheet's Delete.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { ANON_KEY, BACKEND_ORIGIN, FIXED_NOW_MS, STORAGE_KEY } from './constants';
import { USER, buildFixtures } from './fixtures';
import { createMockBackend } from './mock-backend';
import { SEED_SESSION_TTL_SECONDS, buildSession } from './session';

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

function connect() {
  const fx = buildFixtures('default');
  const backend = createMockBackend(fx.seed);
  const session = buildSession(USER, { nowMs: FIXED_NOW_MS, ttlSeconds: SEED_SESSION_TTL_SECONDS });
  const store = new Map<string, string>([[STORAGE_KEY, JSON.stringify(session)]]);
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

const suite = lib ? describe : describe.skip;

// =================================================================================================== macro bars

describe('components/diary/macro-progress.ts: the percentage colour', () => {
  it('a goal (protein) turns green at 100 % and stays neutral below', async () => {
    const { percentTone } = await load('@/components/diary/macro-progress');
    expect(percentTone(0.5, false)).toBe('muted');
    expect(percentTone(0.994, false)).toBe('muted'); // reads 99 %
    expect(percentTone(0.996, false)).toBe('success'); // reads 100 %
    expect(percentTone(1, false)).toBe('success');
    expect(percentTone(1.8, false)).toBe('success');
    expect(percentTone(undefined, false)).toBe('muted');
  });

  it('a limit (energy, carbs, fat) is neutral up to and AT 100 % and red only past it', async () => {
    const { percentTone } = await load('@/components/diary/macro-progress');
    expect(percentTone(0.9, true)).toBe('muted');
    expect(percentTone(1, true)).toBe('muted');
    expect(percentTone(1.004, true)).toBe('muted'); // still reads 100 %
    expect(percentTone(1.006, true)).toBe('danger'); // reads 101 %
    expect(percentTone(2, true)).toBe('danger');
    expect(percentTone(undefined, true)).toBe('muted');
  });
});

describe('components/diary/macro-progress.ts: macroProgress', () => {
  it('energy uses the net amount for the bar and shows it next to the eaten amount', async () => {
    const { macroProgress } = await load('@/components/diary/macro-progress');
    const p = macroProgress({ value: 2376.2, netValue: 2100, target: 2195, unit: 'kcal', decimals: 0, overIsBad: true });
    expect(p.valueText).toBe('2,376 (2,100 net) / 2,195 kcal');
    expect(p.pctText).toBe('96%');
    expect(p.tone).toBe('muted');
    expect(p.mainFill).toBeCloseTo(2100 / 2195, 6);
    expect(p.overFill).toBe(0);
    expect(p.markAt).toBeUndefined();
    expect(p.now).toBe(96);
  });

  it('past the target the track is rescaled: a notch marks the target and the overflow is drawn after it', async () => {
    const { macroProgress } = await load('@/components/diary/macro-progress');
    const p = macroProgress({ value: 2400, target: 2000, unit: 'kcal', overIsBad: true });
    expect(p.pctText).toBe('120%');
    expect(p.tone).toBe('danger');
    expect(p.mainFill).toBeCloseTo(1 / 1.2, 6);
    expect(p.overFill).toBeCloseTo(0.2 / 1.2, 6);
    expect(p.markAt).toBeCloseTo(1 / 1.2, 6);
    expect(p.now).toBe(100);
  });

  it('is capped at twice the target', async () => {
    const { macroProgress } = await load('@/components/diary/macro-progress');
    const p = macroProgress({ value: 300, target: 100, unit: 'g', overIsBad: false });
    expect(p.pctText).toBe('300%');
    expect(p.tone).toBe('success');
    expect(p.mainFill).toBe(0.5);
    expect(p.overFill).toBe(0.5);
    expect(p.markAt).toBe(0.5);
  });

  it('a reached goal is green and fills the whole track', async () => {
    const { macroProgress } = await load('@/components/diary/macro-progress');
    const p = macroProgress({ value: 130, target: 130, unit: 'g', decimals: 1, overIsBad: false });
    expect(p.valueText).toBe('130 / 130 g');
    expect(p.pctText).toBe('100%');
    expect(p.tone).toBe('success');
    expect(p.mainFill).toBe(1);
    expect(p.markAt).toBeUndefined();
  });

  it('without a target (or with an unknown amount) there is no percentage and the bar is empty', async () => {
    const { macroProgress } = await load('@/components/diary/macro-progress');
    const noTarget = macroProgress({ value: 80, unit: 'g' });
    expect(noTarget).toMatchObject({ pct: undefined, pctText: '', valueText: '80 g', mainFill: 0, overFill: 0, now: undefined, tone: 'muted' });
    const zeroTarget = macroProgress({ value: 80, target: 0, unit: 'g' });
    expect(zeroTarget.pctText).toBe('');
    const unknown = macroProgress({ value: undefined, target: 100, unit: 'g' });
    expect(unknown).toMatchObject({ pctText: '', valueText: '- / 100 g', mainFill: 0 });
  });
});

// =================================================================================================== rows

describe('components/diary/entry-summary.ts: the text of a food row', () => {
  it('serving line: portion entries read "2 x slice", gram entries "150 g"; a brand follows after a dot', async () => {
    const { entryAmountLabel, entryRowText } = await load('@/components/diary/entry-summary');
    expect(entryAmountLabel({ grams: 118, amount: 1, portionLabel: 'medium' })).toBe('1 x medium');
    expect(entryAmountLabel({ grams: 60, amount: null, portionLabel: null })).toBe('60 g');
    expect(entryAmountLabel({ grams: 4.5, amount: null, portionLabel: null })).toBe('4.5 g');
    expect(entryAmountLabel({ grams: 100, amount: 100, portionLabel: 'g' })).toBe('100 g'); // a "g" portion is just grams

    const base = { grams: 60, amount: null, portionLabel: null, kcal: 232.4, food: { name: 'Oats, rolled, dry', brand: null } };
    expect(entryRowText(base)).toEqual({
      name: 'Oats, rolled, dry',
      serving: '60 g',
      kcal: '232',
      label: 'Oats, rolled, dry, 60 g, 232 kilocalories. Double tap to edit.',
    });
    const branded = entryRowText({ ...base, food: { name: 'Muesli', brand: '  Alpro ' } });
    expect(branded.serving).toBe('60 g \u00B7 Alpro');
    expect(branded.label).toBe('Muesli, Alpro, 60 g, 232 kilocalories. Double tap to edit.');
  });

  it('the accessible name starts with "<food>, " (the browser run finds rows by it) and says when the energy is unknown', async () => {
    const { entryRowText } = await load('@/components/diary/entry-summary');
    const row = entryRowText({ grams: 100, amount: null, portionLabel: null, kcal: undefined, food: { name: 'Mystery stew', brand: null } });
    expect(row.kcal).toBe('-');
    expect(row.label).toBe('Mystery stew, 100 g, energy unknown. Double tap to edit.');
    expect(row.label.startsWith('Mystery stew, ')).toBe(true);
  });
});

describe('components/diary/activity-rows.ts: exercise, biometric and note rows', () => {
  const exercise = { name: 'Strength training', minutes: 51.2, source: 'garmin', kcal: 163.2, counts_toward_energy: true };

  it('exercise: minutes and source under the name, burned energy as negative kcal', async () => {
    const { exerciseRowText, activityRowLabel } = await load('@/components/diary/activity-rows');
    const text = exerciseRowText(exercise);
    expect(text).toEqual({ title: 'Strength training', detail: '51 min - Garmin', value: '-163', unit: 'kcal', deleteName: 'Strength training' });
    expect(activityRowLabel(text)).toBe('Strength training, 51 min - Garmin, -163 kcal');
    // a manual exercise without minutes has no detail line; "not counted" is called out
    expect(exerciseRowText({ ...exercise, minutes: null, source: 'manual' }).detail).toBeUndefined();
    expect(exerciseRowText({ ...exercise, source: 'manual', counts_toward_energy: false }).detail).toBe('51 min - not counted');
    expect(exerciseRowText({ ...exercise, source: 'health_connect' }).detail).toBe('51 min - Health Connect');
  });

  it('biometric: a pretty type name, the value in the user\'s units, the source of device values', async () => {
    const { biometricRowText } = await load('@/components/diary/activity-rows');
    const weight = { type: 'weight', unit: 'kg', value: 80.46, source: 'manual' };
    expect(biometricRowText(weight, 'metric')).toEqual({ title: 'Weight', value: '80.5 kg', deleteName: 'Weight' });
    expect(biometricRowText(weight, 'imperial').value).toBe('177.4 lb');
    expect(biometricRowText({ type: 'resting_heart_rate', unit: 'bpm', value: 58, source: 'apple_health' }, 'metric')).toEqual({
      title: 'Resting heart rate',
      detail: 'Apple Health',
      value: '58 bpm',
      deleteName: 'Resting heart rate',
    });
  });

  it('note: the text is the title and "note" is what the toast calls it', async () => {
    const { noteRowText, activityRowLabel } = await load('@/components/diary/activity-rows');
    const text = noteRowText({ body: 'Slept badly' });
    expect(text).toEqual({ title: 'Slept badly', deleteName: 'note' });
    expect(activityRowLabel(text)).toBe('Slept badly');
  });
});

// =================================================================================================== swipe to delete

describe('components/diary/swipe-delete.ts', () => {
  it('a row pulled past 60 % of its width deletes on release; an unmeasured row never does', async () => {
    const { FULL_SWIPE_FRACTION, isFullSwipe } = await load('@/components/diary/swipe-delete');
    expect(FULL_SWIPE_FRACTION).toBe(0.6);
    expect(isFullSwipe(0, 400)).toBe(false);
    expect(isFullSwipe(84, 400)).toBe(false); // the resting open position of the red button
    expect(isFullSwipe(240, 400)).toBe(false); // exactly on the line
    expect(isFullSwipe(241, 400)).toBe(true);
    expect(isFullSwipe(400, 400)).toBe(true);
    expect(isFullSwipe(300, 0)).toBe(false);
    expect(isFullSwipe(-50, 400)).toBe(false); // dragging to the right
  });

  it('the red button and the screen reader action are named "Delete <name>"', async () => {
    const { deleteLabel, deleteAccessibilityActions, isDeleteAction, DELETE_ACTION_NAME } = await load('@/components/diary/swipe-delete');
    expect(deleteLabel('Oats, rolled, dry')).toBe('Delete Oats, rolled, dry');
    expect(deleteAccessibilityActions('Oats')).toEqual([{ name: 'delete', label: 'Delete Oats' }]);
    expect(DELETE_ACTION_NAME).toBe('delete');
    expect(isDeleteAction('delete')).toBe(true);
    expect(isDeleteAction('activate')).toBe(false);
  });
});

describe('data/diary-activity-rules.ts', () => {
  it('manual rows and notes can be swiped away; device rows would only come back with the next sync', async () => {
    const { isSwipeDeletable } = await load('@/data/diary-activity-rules');
    expect(isSwipeDeletable('exercise', { source: 'manual' })).toBe(true);
    for (const source of ['garmin', 'apple_health', 'health_connect']) {
      expect(isSwipeDeletable('exercise', { source }), source).toBe(false);
      expect(isSwipeDeletable('biometric', { source }), source).toBe(false);
    }
    expect(isSwipeDeletable('biometric', { source: 'manual' })).toBe(true);
    expect(isSwipeDeletable('note', { body: 'x' })).toBe(true); // notes have no source
  });

  it('Undo writes the original columns back for the signed-in user and nothing else', async () => {
    const { buildActivityRestoreRow } = await load('@/data/diary-activity-rules');
    const note = { id: 'n1', user_id: 'someone-else', entry_date: '2026-11-10', body: 'x', created_at: '2026-11-10T10:10:00Z', extra: 'dropped' };
    expect(buildActivityRestoreRow('note', note, 'me')).toEqual({ user_id: 'me', id: 'n1', entry_date: '2026-11-10', body: 'x', created_at: '2026-11-10T10:10:00Z' });
    const bio = { id: 'b1', entry_date: '2026-11-10', type: 'weight', value: 80, unit: 'kg', source: 'manual', external_id: null, recorded_at: 't', meta: null };
    expect(buildActivityRestoreRow('biometric', bio, 'me')).toMatchObject({ user_id: 'me', id: 'b1', meta: {}, external_id: null });
  });
});

// =================================================================================================== data layer

suite('data/diary-activity-rules.ts against the mock backend: delete + Undo of exercise, biometric and note rows', () => {
  const TABLES = { exercise: 'exercise_entries', biometric: 'biometrics', note: 'notes' } as const;

  for (const [kind, table] of Object.entries(TABLES)) {
    it(`${kind}: the restored row is accepted by the database schema and is identical to the deleted one`, async () => {
      const { buildActivityRestoreRow, isSwipeDeletable } = await load('@/data/diary-activity-rules');
      const { backend } = connect();
      const row = backend.rows(table).find((r) => isSwipeDeletable(kind, r));
      expect(row, `a swipe-deletable ${kind} row in the fixtures`).toBeDefined();
      const original = structuredClone(row) as Record<string, unknown>;

      const del = await holder.client.from(table).delete().eq('id', original.id);
      expect(del.error).toBeNull();
      expect(backend.rows(table).some((r) => r.id === original.id)).toBe(false);

      const ins = await holder.client.from(table).insert(buildActivityRestoreRow(kind, original, USER.id));
      expect(ins.error).toBeNull();
      const back = backend.rows(table).find((r) => r.id === original.id);
      expect(back).toEqual(original);
      expect(backend.mutations.filter((m) => !m.ok)).toEqual([]);
      expect(backend.integrityErrors()).toEqual([]);
    });
  }
});
