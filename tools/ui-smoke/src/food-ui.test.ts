/**
 * The pure rules behind the search / scan screens, run through the app's `@/` alias:
 *  - components/food/scan-code.ts: what a code seen by the camera means (retail barcode, QR code, misread)
 *  - components/food/source-label.ts: the right-aligned source label of a food row (wording and colour)
 * plus the one data-layer function the scanner added (fetchFoodIdentity) against the mock backend.
 *
 * Skipped when the app's dependencies are not installed.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { ANON_KEY, BACKEND_ORIGIN, FIXED_NOW_MS, STORAGE_KEY } from './constants';
import { BARCODES, IDS, USER, buildFixtures } from './fixtures';
import { createMockBackend } from './mock-backend';
import { SEED_SESSION_TTL_SECONDS, buildSession } from './session';

const holder = vi.hoisted(() => ({ client: null as any }));

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: true,
  supabase: new Proxy({}, { get: (_target, prop) => holder.client?.[prop] }),
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
const suite = lib ? describe : describe.skip;

/** App modules are untyped here on purpose (this package's tsconfig knows nothing about React Native). */
const load = (specifier: string): Promise<any> => import(/* @vite-ignore */ specifier);

// Check digits verified by hand: every code below is a real, valid GTIN.
const EAN13 = BARCODES.nutella; // 3017620422003
const EAN8 = '96385074';
const UPC_A = '036000291452';
const UPC_E = '04252614'; // expands to UPC-A 042100005264
const GTIN14 = '09506000134352'; // the GS1 example product, as a 14 digit number

suite('components/food/scan-code.ts: classifyScan', () => {
  it('retail barcodes with a valid check digit become a GTIN-14 to look up', async () => {
    const { classifyScan } = await load('@/components/food/scan-code');
    expect(classifyScan('ean13', EAN13)).toEqual({ kind: 'gtin', gtin14: `0${EAN13}`, display: EAN13 });
    expect(classifyScan('ean8', EAN8)).toEqual({ kind: 'gtin', gtin14: `000000${EAN8}`, display: EAN8 });
    expect(classifyScan('upc_a', UPC_A)).toEqual({ kind: 'gtin', gtin14: `00${UPC_A}`, display: UPC_A });
    // iOS reports a UPC-A as an EAN-13 with a leading zero: same product
    expect(classifyScan('ean13', `0${UPC_A}`)).toMatchObject({ kind: 'gtin', gtin14: `00${UPC_A}` });
    // surrounding whitespace is ignored
    expect(classifyScan('ean13', `  ${EAN13}\n`)).toMatchObject({ kind: 'gtin', gtin14: `0${EAN13}` });
  });

  it('UPC-E is expanded to UPC-A first; the display keeps the digits that are printed on the pack', async () => {
    const { classifyScan } = await load('@/components/food/scan-code');
    expect(classifyScan('upc_e', UPC_E)).toEqual({ kind: 'gtin', gtin14: '00042100005264', display: UPC_E });
  });

  it('a wrong check digit is a misread (keep scanning), never a lookup', async () => {
    const { classifyScan, MISREAD_NOTICE } = await load('@/components/food/scan-code');
    for (const [type, code] of [
      ['ean13', '3017620422004'],
      ['ean8', '96385075'],
      ['upc_a', '036000291453'],
      ['upc_e', '04252615'],
      ['ean13', '123'],
      ['ean13', 'not digits'],
    ] as const) {
      expect(classifyScan(type, code), `${type} ${code}`).toEqual({ kind: 'misread', notice: MISREAD_NOTICE });
    }
  });

  it('a QR code holding a product number is looked up like a barcode', async () => {
    const { classifyScan } = await load('@/components/food/scan-code');
    expect(classifyScan('qr', EAN13)).toEqual({ kind: 'gtin', gtin14: `0${EAN13}`, display: EAN13 });
    // a plain number is shown as it was read; a link is shown as the number is usually printed (without padding zeros)
    expect(classifyScan('qr', ` ${GTIN14} `)).toMatchObject({ kind: 'gtin', gtin14: GTIN14, display: GTIN14 });
  });

  it('a GS1 Digital Link QR code (the link printed on some packaging) is looked up', async () => {
    const { classifyScan } = await load('@/components/food/scan-code');
    for (const link of [
      `https://id.gs1.org/01/${GTIN14}`,
      `https://id.gs1.org/01/${GTIN14}/10/ABC123?17=261231`,
      `http://example.com/gs1/01/${GTIN14}?x=1`,
      `HTTPS://brand.example/01/${GTIN14}#top`,
    ]) {
      expect(classifyScan('qr', link), link).toMatchObject({ kind: 'gtin', gtin14: GTIN14, display: '9506000134352' });
    }
    // a link whose product number is wrong, or that has none, is not a food barcode
    expect(classifyScan('qr', 'https://id.gs1.org/01/09506000134353')).toMatchObject({ kind: 'notFood' });
    expect(classifyScan('qr', `https://id.gs1.org/02/${GTIN14}`)).toMatchObject({ kind: 'notFood' });
  });

  it('any other QR code shows the friendly "not a food barcode" message instead of an error', async () => {
    const { classifyScan, NOT_FOOD_QR_NOTICE } = await load('@/components/food/scan-code');
    expect(NOT_FOOD_QR_NOTICE).toBe('That QR code is not a food barcode');
    for (const content of [
      'https://example.com/menu',
      'WIFI:T:WPA;S:home;P:secret;;',
      'BEGIN:VCARD\nFN:Ana\nEND:VCARD',
      'hello',
      '',
      '2024-11-10', // digits and dashes are not a product number
      '12345', // wrong length
      '3017620422004', // right length, wrong check digit
    ]) {
      expect(classifyScan('qr', content), JSON.stringify(content)).toEqual({ kind: 'notFood', notice: NOT_FOOD_QR_NOTICE });
    }
  });

  it('Code 128 counts only for a valid product number (plain, or GS1-128 starting with identifier 01)', async () => {
    const { classifyScan, NOT_FOOD_CODE_NOTICE } = await load('@/components/food/scan-code');
    expect(classifyScan('code128', EAN13)).toMatchObject({ kind: 'gtin', gtin14: `0${EAN13}` });
    expect(classifyScan('code128', `01${GTIN14}`)).toMatchObject({ kind: 'gtin', gtin14: GTIN14 });
    expect(classifyScan('code128', `(01)${GTIN14}(17)261231`)).toMatchObject({ kind: 'gtin', gtin14: GTIN14 });
    for (const content of ['SHIP-8841-X', '0000123456', `01${GTIN14.slice(0, -1)}0`]) {
      expect(classifyScan('code128', content), content).toEqual({ kind: 'notFood', notice: NOT_FOOD_CODE_NOTICE });
    }
  });

  it('the type is matched case-insensitively and the scanner asks the camera for the retail types plus QR', async () => {
    const { classifyScan, SCAN_BARCODE_TYPES } = await load('@/components/food/scan-code');
    expect(classifyScan('EAN13', EAN13)).toMatchObject({ kind: 'gtin' });
    expect(classifyScan('QR', 'hello')).toMatchObject({ kind: 'notFood' });
    expect([...SCAN_BARCODE_TYPES].sort()).toEqual(['code128', 'ean13', 'ean8', 'qr', 'upc_a', 'upc_e']);
  });
});

suite('components/food/source-label.ts: the source label of a food row', () => {
  it('own foods and recipes are named for what they are, database foods show their database', async () => {
    const { foodSourceLabel } = await load('@/components/food/source-label');
    expect(foodSourceLabel('custom', 'custom')).toEqual({ text: 'Custom Food', full: 'Custom food', tone: 'custom' });
    expect(foodSourceLabel('recipe', 'recipe')).toEqual({ text: 'Custom Recipe', full: 'Custom recipe', tone: 'recipe' });
    expect(foodSourceLabel('ai_estimate', 'ai_estimate')).toEqual({ text: 'AI Estimate', full: 'AI estimate', tone: 'ai' });
    expect(foodSourceLabel('fdc_foundation', 'generic')).toEqual({ text: 'USDA', full: 'USDA FoodData Central', tone: 'database' });
    expect(foodSourceLabel('fdc_branded', 'branded')).toMatchObject({ text: 'USDA', tone: 'database' });
    expect(foodSourceLabel('cnf')).toMatchObject({ text: 'CNF', tone: 'database' });
    expect(foodSourceLabel('cofid')).toMatchObject({ text: 'CoFID', tone: 'database' });
    expect(foodSourceLabel('off', 'branded')).toEqual({ text: 'OFF', full: 'Open Food Facts', tone: 'database' });
  });

  it('the kind alone is enough to recognise an own food (a row without the source column filled in)', async () => {
    const { foodSourceLabel } = await load('@/components/food/source-label');
    expect(foodSourceLabel('off', 'recipe').tone).toBe('recipe');
    expect(foodSourceLabel('off', 'custom').tone).toBe('custom');
    expect(foodSourceLabel('off', null).tone).toBe('database');
  });

  it('every food source has a label, and a saved meal is a recipe-coloured "Saved Meal"', async () => {
    const { SOURCES, foodSourceLabel, SAVED_MEAL_LABEL, sourceInfo } = await load('@/components/food/source-label');
    const all = ['fdc_foundation', 'fdc_sr_legacy', 'fdc_fndds', 'fdc_branded', 'cnf', 'cofid', 'off', 'custom', 'recipe', 'ai_estimate'];
    expect(Object.keys(SOURCES).sort()).toEqual([...all].sort());
    for (const source of all) {
      const label = foodSourceLabel(source);
      expect(label.text.length, source).toBeGreaterThan(0);
      expect(label.full.length, source).toBeGreaterThan(0);
      expect(sourceInfo(source)).toBe(SOURCES[source]); // the food detail badge reads the same table
    }
    expect(SAVED_MEAL_LABEL).toEqual({ text: 'Saved Meal', full: 'Saved meal', tone: 'recipe' });
  });

  it('colours: custom = primary, recipe / saved meal = teal (carbs), AI = purple (fat), database = muted', async () => {
    const { sourceToneColor } = await load('@/components/food/source-label');
    const { lightColors, darkColors } = await load('@/theme/colors');
    for (const colors of [lightColors, darkColors]) {
      expect(sourceToneColor('custom', colors)).toBe(colors.primary);
      expect(sourceToneColor('recipe', colors)).toBe(colors.carbs);
      expect(sourceToneColor('ai', colors)).toBe(colors.fat);
      expect(sourceToneColor('database', colors)).toBe(colors.textMuted);
    }
  });
});

suite('data/foods.ts: fetchFoodIdentity (the scanner hands a scanned product to a recipe as an ingredient)', () => {
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

  it('returns the name and brand of a food, null for an unknown or malformed id', async () => {
    const { backend } = connect();
    const { fetchFoodIdentity } = await load('@/data/foods');
    const nutella = backend.rows('foods').find((f) => f.id === IDS.food.nutella);
    expect(nutella).toBeDefined();
    const identity = await fetchFoodIdentity(IDS.food.nutella);
    expect(identity).toEqual({ name: nutella?.name, brand: nutella?.brand ?? null });
    expect(identity?.name).toContain('Nutella');
    expect(await fetchFoodIdentity(IDS.missing)).toBeNull();
    expect(await fetchFoodIdentity('not-a-uuid')).toBeNull();
  });
});
