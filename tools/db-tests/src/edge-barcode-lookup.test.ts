import { describe, expect, it, vi } from 'vitest';
import {
  barcodeLookup,
  DEFAULT_OFF_USER_AGENT,
  type BarcodeLookupDeps,
} from '../../../supabase/functions/_shared/barcode-lookup.ts';
import type { BuiltFood } from '../../../supabase/functions/_shared/food-row.ts';
import {
  makeLocalLookup,
  makeUpsertFood,
  StoreError,
  type QueryLike,
  type SupabaseLike,
  type SupabaseResult,
} from '../../../supabase/functions/_shared/food-store.ts';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function fakeFetch(handlers: Array<[string, Handler]>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const match = handlers.find(([needle]) => url.includes(needle));
    if (!match) throw new Error(`unexpected fetch: ${url}`);
    return match[1](url, init);
  };
  return { fn, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const FDC = 'api.nal.usda.gov/fdc/v1/foods/search';
const OFF = 'world.openfoodfacts.org/api/v2/product/';

const UPC = '036000291452'; // valid UPC-A
const UPC_14 = '00036000291452';
const EAN = '4006381333931'; // valid EAN-13
const EAN_14 = '04006381333931';

const fdcItem = (fdcId: number, extra: Record<string, unknown> = {}) => ({
  fdcId,
  description: 'KLEENEX COOKIES',
  dataType: 'Branded',
  gtinUpc: UPC,
  brandName: 'KLEENEX',
  modifiedDate: '2021-01-01',
  servingSize: 30,
  servingSizeUnit: 'g',
  householdServingFullText: '3 cookies',
  foodNutrients: [
    { nutrientId: 1008, unitName: 'KCAL', value: 480 },
    { nutrientId: 1003, unitName: 'G', value: 6 },
    { nutrientId: 1005, unitName: 'G', value: 70 },
    { nutrientId: 1004, unitName: 'G', value: 20 },
  ],
  ...extra,
});

const offResponse = (extra: Record<string, unknown> = {}, code = EAN) => ({
  code,
  status: 1,
  status_verbose: 'product found',
  product: {
    code,
    product_name: 'Dark chocolate',
    brands: 'Choco,Brand',
    nutrition_data_per: '100g',
    serving_size: '25 g',
    serving_quantity: 25,
    countries_tags: ['en:germany'],
    nutriments: {
      'energy-kcal_100g': 560,
      proteins_100g: 7,
      carbohydrates_100g: 45,
      fat_100g: 38,
      salt_100g: 0.05,
    },
    ...extra,
  },
});

function setup(opts: {
  handlers?: Array<[string, Handler]>;
  local?: Awaited<ReturnType<BarcodeLookupDeps['localLookup']>>;
  env?: BarcodeLookupDeps['env'];
  upsertError?: Error;
}) {
  const net = fakeFetch(opts.handlers ?? []);
  const upserts: BuiltFood[] = [];
  const localLookup = vi.fn(async (_g: string) => opts.local ?? null);
  const upsertFood = vi.fn(async (built: BuiltFood) => {
    if (opts.upsertError) throw opts.upsertError;
    upserts.push(built);
    return {
      action: 'inserted',
      food: { id: 'food-1', ...built.food },
      portions: built.portions.map((p, i) => ({ id: `portion-${i}`, ...p })),
    };
  });
  const log = vi.fn();
  const deps: BarcodeLookupDeps = {
    fetch: net.fn,
    localLookup,
    upsertFood,
    env: opts.env ?? {
      FDC_API_KEY: 'fdc-key',
      OFF_USER_AGENT: 'ration-test/1.0 (me@example.com)',
    },
    log,
  };
  return { deps, net, upserts, localLookup, upsertFood, log };
}

const fdcHit = (items: unknown[]): [string, Handler] => [
  FDC,
  () => json({ totalHits: items.length, foods: items }),
];
const offHit = (body: unknown = offResponse()): [string, Handler] => [OFF, () => json(body)];
const offMiss: [string, Handler] = [
  OFF,
  () => json({ code: EAN, status: 0, status_verbose: 'product not found' }, 404),
];

// ---------------------------------------------------------------------------
// barcode-lookup orchestration
// ---------------------------------------------------------------------------
describe('barcodeLookup', () => {
  describe('input validation', () => {
    it.each([
      ['missing gtin', {}],
      ['body not an object', 'abc'],
      ['null body', null],
      ['array body', [UPC]],
      ['numeric gtin', { gtin: 36000291452 }],
      ['letters', { gtin: '1234abcd' }],
      ['too long', { gtin: '123456789012345' }],
      ['all zeros', { gtin: '000000000000' }],
      ['empty', { gtin: '' }],
    ])('400 invalid_gtin for %s, without touching DB or network', async (_label, body) => {
      const t = setup({});
      const res = await barcodeLookup(body, t.deps);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'invalid_gtin' });
      expect(t.localLookup).not.toHaveBeenCalled();
      expect(t.net.calls).toHaveLength(0);
    });
  });

  describe('(a) local hit', () => {
    const local = {
      food: { id: 'local-1', name: 'Cached cookies', source: 'fdc_branded' },
      portions: [{ id: 'p1', label: '100 g', grams: 100 }],
    };

    it('short-circuits all remote calls and the upsert', async () => {
      const t = setup({ local, handlers: [] });
      const res = await barcodeLookup({ gtin: UPC }, t.deps);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ food: local.food, portions: local.portions, source: 'local' });
      expect(t.localLookup).toHaveBeenCalledWith(UPC_14);
      expect(t.net.calls).toHaveLength(0);
      expect(t.upsertFood).not.toHaveBeenCalled();
    });

    it('passes the check-digit warning through', async () => {
      const t = setup({ local });
      const res = await barcodeLookup({ gtin: '036000291453' }, t.deps);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ source: 'local', warning: 'invalid_check_digit' });
    });
  });

  describe('(b) FDC', () => {
    it('queries FDC with the barcode and saves the matching branded item', async () => {
      const t = setup({
        handlers: [fdcHit([fdcItem(111, { gtinUpc: '036000291469' }), fdcItem(222)])],
      });
      const res = await barcodeLookup({ gtin: UPC }, t.deps);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        source: 'fdc_branded',
        food: {
          id: 'food-1',
          source: 'fdc_branded',
          source_id: '222',
          name: 'Kleenex Cookies',
          brand: 'Kleenex',
        },
      });
      expect((res.body as { warning?: string }).warning).toBeUndefined();
      // only FDC was called
      expect(t.net.calls).toHaveLength(1);
      const url = new URL(t.net.calls[0]!.url);
      expect(url.origin + url.pathname).toBe('https://api.nal.usda.gov/fdc/v1/foods/search');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        query: UPC,
        dataType: 'Branded',
        pageSize: '5',
        api_key: 'fdc-key',
      });
    });

    it('upserts the exact row shape and portions', async () => {
      const t = setup({ handlers: [fdcHit([fdcItem(222)])] });
      await barcodeLookup({ gtin: UPC }, t.deps);
      expect(t.upserts).toHaveLength(1);
      expect(t.upserts[0]).toEqual({
        food: {
          source: 'fdc_branded',
          source_id: '222',
          kind: 'branded',
          owner_id: null,
          name: 'Kleenex Cookies',
          brand: 'Kleenex',
          gtin14: UPC_14,
          category: null,
          nutrients: { ENERGY_KCAL: 480, PROTEIN_G: 6, CARBS_G: 70, FAT_G: 20 },
          completeness: expect.any(Number),
          carb_basis: 'includes_fiber',
          density_g_per_ml: null,
          popularity: 0,
        },
        portions: [
          { label: '100 g', amount: 100, unit: 'g', grams: 100, sort_order: 0 },
          { label: '3 cookies (30 g)', amount: 1, unit: 'serving', grams: 30, sort_order: 1 },
        ],
      });
      expect(t.upserts[0]!.food.completeness).toBeGreaterThan(0);
    });

    it('picks the item with the newest modifiedDate/publishedDate', async () => {
      const t = setup({
        handlers: [
          fdcHit([
            fdcItem(1, { modifiedDate: '2019-05-01' }),
            fdcItem(2, { modifiedDate: '2022-02-01' }),
            fdcItem(3, { modifiedDate: '2020-01-01', publishedDate: '2021-01-01' }),
          ]),
        ],
      });
      await barcodeLookup({ gtin: UPC }, t.deps);
      expect(t.upserts[0]!.food.source_id).toBe('2');
    });

    it('skips a matching item without nutrition and uses the next one', async () => {
      const t = setup({
        handlers: [
          fdcHit([fdcItem(9, { foodNutrients: [], modifiedDate: '2023-01-01' }), fdcItem(8)]),
        ],
      });
      const res = await barcodeLookup({ gtin: UPC }, t.deps);
      expect(res.status).toBe(200);
      expect(t.upserts[0]!.food.source_id).toBe('8');
    });

    it('a UPC-A request also matches an FDC item stored as EAN-13', async () => {
      const t = setup({ handlers: [fdcHit([fdcItem(5, { gtinUpc: '0' + UPC })])] });
      const res = await barcodeLookup({ gtin: UPC }, t.deps);
      expect(res.body).toMatchObject({ source: 'fdc_branded' });
    });

    it('ml servings set the density', async () => {
      const t = setup({
        handlers: [
          fdcHit([
            fdcItem(5, {
              servingSize: 330,
              servingSizeUnit: 'ml',
              householdServingFullText: '1 can',
            }),
          ]),
        ],
      });
      await barcodeLookup({ gtin: UPC }, t.deps);
      expect(t.upserts[0]!.food.density_g_per_ml).toBe(1);
      expect(t.upserts[0]!.portions[1]).toMatchObject({ label: '1 can (330 ml)', grams: 330 });
    });

    it('is skipped when FDC_API_KEY is not configured', async () => {
      const t = setup({ handlers: [offHit()], env: { OFF_USER_AGENT: 'ua' } });
      const res = await barcodeLookup({ gtin: EAN }, t.deps);
      expect(res.body).toMatchObject({ source: 'off' });
      expect(t.net.calls.map((c) => c.url).some((u) => u.includes(FDC))).toBe(false);
    });
  });

  describe('(c) Open Food Facts fallback', () => {
    it('falls back to OFF when FDC has no matching item', async () => {
      const t = setup({ handlers: [fdcHit([fdcItem(1, { gtinUpc: '036000291469' })]), offHit()] });
      const res = await barcodeLookup({ gtin: EAN }, t.deps);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        source: 'off',
        food: {
          source: 'off',
          source_id: EAN,
          name: 'Dark chocolate',
          brand: 'Choco',
          gtin14: EAN_14,
        },
      });
      expect(t.upserts[0]).toMatchObject({
        food: {
          source: 'off',
          source_id: EAN,
          kind: 'branded',
          owner_id: null,
          carb_basis: 'excludes_fiber',
          nutrients: { ENERGY_KCAL: 560, PROTEIN_G: 7, CARBS_G: 45, FAT_G: 38, SODIUM_MG: 20 },
        },
        portions: [
          { label: '100 g', grams: 100, sort_order: 0 },
          { label: '1 serving (25 g)', grams: 25, unit: 'serving', sort_order: 1 },
        ],
      });
    });

    it('sends the configured User-Agent, the field list and makes exactly one OFF request', async () => {
      const t = setup({ handlers: [fdcHit([]), offHit()] });
      await barcodeLookup({ gtin: EAN }, t.deps);
      const offCalls = t.net.calls.filter((c) => c.url.includes(OFF));
      expect(offCalls).toHaveLength(1);
      const call = offCalls[0]!;
      expect(
        call.url.startsWith(`https://world.openfoodfacts.org/api/v2/product/${EAN}.json?fields=`),
      ).toBe(true);
      for (const f of [
        'code',
        'product_name',
        'brands',
        'nutriments',
        'serving_size',
        'serving_quantity',
        'serving_quantity_unit',
        'countries_tags',
        'categories_tags_en',
        'nutrition_data_per',
      ]) {
        expect(call.url).toContain(f);
      }
      expect((call.init!.headers as Record<string, string>)['User-Agent']).toBe(
        'ration-test/1.0 (me@example.com)',
      );
    });

    it('uses the default User-Agent when none is configured', async () => {
      const t = setup({ handlers: [offHit()], env: {} });
      await barcodeLookup({ gtin: EAN }, t.deps);
      expect((t.net.calls[0]!.init!.headers as Record<string, string>)['User-Agent']).toBe(
        DEFAULT_OFF_USER_AGENT,
      );
      expect(DEFAULT_OFF_USER_AGENT).toBe('ration/1.0 (contact not configured)');
    });

    it('requests a UPC-A as EAN-13 (OFF stores a leading zero)', async () => {
      const t = setup({ handlers: [fdcHit([]), [OFF, () => json(offResponse({}, '0' + UPC))]] });
      const res = await barcodeLookup({ gtin: UPC }, t.deps);
      expect(res.status).toBe(200);
      expect(t.net.calls[1]!.url).toContain(`/product/0${UPC}.json`);
      expect(t.upserts[0]!.food.source_id).toBe('0' + UPC);
    });

    it('treats a product returned for another code as a miss (never saves it under this barcode)', async () => {
      const t = setup({ handlers: [offHit(offResponse({}, '5449000000996'))], env: {} });
      const res = await barcodeLookup({ gtin: EAN }, t.deps);
      expect(res.status).toBe(404);
      expect(t.upsertFood).not.toHaveBeenCalled();
    });

    it('treats an OFF product without nutrition data as not found', async () => {
      const t = setup({ handlers: [offHit(offResponse({ nutriments: {} }))], env: {} });
      const res = await barcodeLookup({ gtin: EAN }, t.deps);
      expect(res.status).toBe(404);
    });

    it('handles per-serving OFF products', async () => {
      const t = setup({
        handlers: [
          offHit(
            offResponse({
              nutrition_data_per: 'serving',
              serving_quantity: '50',
              nutriments: { 'energy-kcal_serving': 100, proteins_serving: 5 },
            }),
          ),
        ],
        env: {},
      });
      await barcodeLookup({ gtin: EAN }, t.deps);
      expect(t.upserts[0]!.food.nutrients).toEqual({ ENERGY_KCAL: 200, PROTEIN_G: 10 });
    });
  });

  describe('misses and errors', () => {
    it('404 not_found when both sources miss (HTTP 404 and status:0 bodies)', async () => {
      for (const off of [
        offMiss,
        [OFF, () => json({ code: EAN, status: 0 })] as [string, Handler],
      ]) {
        const t = setup({ handlers: [fdcHit([]), off] });
        const res = await barcodeLookup({ gtin: EAN }, t.deps);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({
          error: 'not_found',
          message: expect.any(String),
          gtin14: EAN_14,
        });
        expect(t.upsertFood).not.toHaveBeenCalled();
      }
    });

    it('404 keeps the barcode warning', async () => {
      const t = setup({ handlers: [fdcHit([]), offMiss] });
      const res = await barcodeLookup({ gtin: '4006381333932' }, t.deps);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ warning: 'invalid_check_digit' });
    });

    it('surfaces an OFF 429 as rate_limited with retryAfterSeconds (one OFF call, nothing saved)', async () => {
      const t = setup({
        handlers: [fdcHit([]), [OFF, () => json({}, 429, { 'Retry-After': '42' })]],
      });
      const res = await barcodeLookup({ gtin: EAN }, t.deps);
      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({
        error: 'rate_limited',
        retryAfterSeconds: 42,
        upstream: 'off',
      });
      expect(res.headers).toEqual({ 'Retry-After': '42' });
      expect(t.net.calls.filter((c) => c.url.includes(OFF))).toHaveLength(1);
      expect(t.upsertFood).not.toHaveBeenCalled();
    });

    it('an OFF 429 without Retry-After defaults to 60 s', async () => {
      const t = setup({ handlers: [[OFF, () => json({}, 429)]], env: {} });
      const res = await barcodeLookup({ gtin: EAN }, t.deps);
      expect(res.body).toMatchObject({ retryAfterSeconds: 60 });
    });

    it('502 upstream_error when OFF fails (5xx, network error, invalid JSON)', async () => {
      const failures: Array<[string, Handler]> = [
        [OFF, () => json({}, 503)],
        [OFF, () => Promise.reject(new TypeError('fetch failed'))],
        [OFF, () => new Response('<html>overloaded</html>', { status: 200 })],
      ];
      for (const failure of failures) {
        const t = setup({ handlers: [fdcHit([]), failure] });
        const res = await barcodeLookup({ gtin: EAN }, t.deps);
        expect(res.status).toBe(502);
        expect(res.body).toMatchObject({ error: 'upstream_error', upstream: 'off' });
      }
    });

    it('FDC 429 does not stop the OFF fallback; if OFF misses too the answer is rate_limited', async () => {
      const fdc429: [string, Handler] = [FDC, () => json({}, 429, { 'Retry-After': '900' })];
      const hit = setup({ handlers: [fdc429, offHit()] });
      expect((await barcodeLookup({ gtin: EAN }, hit.deps)).body).toMatchObject({ source: 'off' });

      const miss = setup({ handlers: [fdc429, offMiss] });
      const res = await barcodeLookup({ gtin: EAN }, miss.deps);
      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({
        error: 'rate_limited',
        retryAfterSeconds: 900,
        upstream: 'fdc',
      });
    });

    it('FDC failure + OFF miss is a 502 (we cannot claim the barcode is unknown); FDC failure + OFF hit succeeds', async () => {
      const fdc500: [string, Handler] = [FDC, () => json({ error: 'boom' }, 500)];
      const miss = setup({ handlers: [fdc500, offMiss] });
      const res = await barcodeLookup({ gtin: EAN }, miss.deps);
      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({ error: 'upstream_error', upstream: 'fdc' });

      const hit = setup({ handlers: [fdc500, offHit()] });
      expect((await barcodeLookup({ gtin: EAN }, hit.deps)).status).toBe(200);
    });

    it('a failed upsert is a 500 save_failed and is logged', async () => {
      const t = setup({ handlers: [fdcHit([fdcItem(1)])], upsertError: new Error('db down') });
      const res = await barcodeLookup({ gtin: UPC }, t.deps);
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ error: 'save_failed' });
      expect(t.log).toHaveBeenCalled();
    });

    it('lets an unexpected local lookup failure propagate (handleHttp turns it into a 500)', async () => {
      const t = setup({});
      t.localLookup.mockRejectedValueOnce(new StoreError('get_food_by_gtin', { message: 'boom' }));
      await expect(barcodeLookup({ gtin: UPC }, t.deps)).rejects.toBeInstanceOf(StoreError);
    });
  });

  it('adds the check-digit warning to remote hits', async () => {
    const t = setup({ handlers: [fdcHit([]), offHit(offResponse({}, '4006381333932'))] });
    const res = await barcodeLookup({ gtin: '4006381333932' }, t.deps);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'off', warning: 'invalid_check_digit' });
  });
});

// ---------------------------------------------------------------------------
// Supabase adapters (fake clients)
// ---------------------------------------------------------------------------
function fakeQuery(
  result: SupabaseResult<unknown[]>,
  log: Array<[string, ...unknown[]]>,
): QueryLike {
  const q: QueryLike = {
    select: (c) => (log.push(['select', c]), q),
    eq: (c, v) => (log.push(['eq', c, v]), q),
    order: (c, o) => (log.push(['order', c, o]), q),
    then: (ok, err) => Promise.resolve(result).then(ok, err),
  };
  return q;
}

describe('makeLocalLookup', () => {
  const foodRow = { id: 'f1', name: 'X', search: "'x':1", search_text: 'x', gtin14: UPC_14 };

  it('calls get_food_by_gtin as the user, reads the portions and strips the search columns', async () => {
    const rpc = vi.fn(async () => ({ data: [foodRow], error: null }));
    const log: Array<[string, ...unknown[]]> = [];
    const portions = [{ id: 'p1', label: '100 g', grams: 100 }];
    const client: SupabaseLike = {
      rpc,
      from: (table) => (log.push(['from', table]), fakeQuery({ data: portions, error: null }, log)),
    };
    const found = await makeLocalLookup(client)(UPC_14);
    expect(rpc).toHaveBeenCalledWith('get_food_by_gtin', { gtin: UPC_14 });
    expect(found).toEqual({ food: { id: 'f1', name: 'X', gtin14: UPC_14 }, portions });
    expect(log).toEqual([
      ['from', 'food_portions'],
      ['select', 'id,label,amount,unit,grams,sort_order'],
      ['eq', 'food_id', 'f1'],
      ['order', 'sort_order', { ascending: true }],
    ]);
  });

  it('accepts a single-object rpc result and returns null on a miss', async () => {
    const miss: SupabaseLike = {
      rpc: async () => ({ data: [], error: null }),
      from: () => fakeQuery({ data: [], error: null }, []),
    };
    expect(await makeLocalLookup(miss)(UPC_14)).toBeNull();
    const nullData: SupabaseLike = {
      rpc: async () => ({ data: null, error: null }),
      from: miss.from,
    };
    expect(await makeLocalLookup(nullData)(UPC_14)).toBeNull();
    const single: SupabaseLike = {
      rpc: async () => ({ data: foodRow, error: null }),
      from: miss.from,
    };
    expect((await makeLocalLookup(single)(UPC_14))!.food.id).toBe('f1');
  });

  it('throws StoreError on rpc or portion errors', async () => {
    const rpcFail: SupabaseLike = {
      rpc: async () => ({ data: null, error: { message: 'permission denied', code: '42501' } }),
      from: () => fakeQuery({ data: [], error: null }, []),
    };
    await expect(makeLocalLookup(rpcFail)(UPC_14)).rejects.toMatchObject({
      name: 'StoreError',
      code: '42501',
    });
    const portionFail: SupabaseLike = {
      rpc: async () => ({ data: [foodRow], error: null }),
      from: () => fakeQuery({ data: null, error: { message: 'nope' } }, []),
    };
    await expect(makeLocalLookup(portionFail)(UPC_14)).rejects.toBeInstanceOf(StoreError);
  });
});

describe('makeUpsertFood', () => {
  const built: BuiltFood = {
    food: {
      source: 'off',
      source_id: '1',
      kind: 'branded',
      owner_id: null,
      name: 'x',
      brand: null,
      gtin14: EAN_14,
      category: null,
      nutrients: { ENERGY_KCAL: 1 },
      completeness: 0.01,
      carb_basis: 'excludes_fiber',
      density_g_per_ml: null,
      popularity: 0,
    },
    portions: [{ label: '100 g', amount: 100, unit: 'g', grams: 100, sort_order: 0 }],
  };

  it('calls upsert_branded_food with the built row and returns the stored row', async () => {
    const rpc = vi.fn(async () => ({
      data: {
        action: 'inserted',
        food: { id: 'f1', search: 'x', name: 'x' },
        portions: [{ id: 'p1' }],
      },
      error: null,
    }));
    const res = await makeUpsertFood({ rpc, from: () => fakeQuery({ data: [], error: null }, []) })(
      built,
    );
    expect(rpc).toHaveBeenCalledWith('upsert_branded_food', {
      p_food: built.food,
      p_portions: built.portions,
    });
    expect(res).toEqual({
      action: 'inserted',
      food: { id: 'f1', name: 'x' },
      portions: [{ id: 'p1' }],
    });
  });

  it('throws on rpc errors and malformed answers', async () => {
    const from = () => fakeQuery({ data: [], error: null }, []);
    await expect(
      makeUpsertFood({ rpc: async () => ({ data: null, error: { message: 'boom' } }), from })(
        built,
      ),
    ).rejects.toBeInstanceOf(StoreError);
    await expect(
      makeUpsertFood({ rpc: async () => ({ data: { action: 'inserted' }, error: null }), from })(
        built,
      ),
    ).rejects.toThrow(/unexpected response shape/);
  });
});
