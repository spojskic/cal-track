import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SEARCH_LIMITS,
  GLOBAL_SEARCH_BUCKET,
  mergeResults,
  onlineSearch,
  SEARCH_BUCKET,
  summarize,
  type OnlineSearchDeps,
  type SearchSummary,
} from '../../../supabase/functions/_shared/online-search.ts';
import { DEFAULT_OFF_USER_AGENT } from '../../../supabase/functions/_shared/barcode-lookup.ts';
import { GLOBAL_RATE_LIMIT_USER } from '../../../supabase/functions/_shared/rate-limit.ts';

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
const OFF = 'search.openfoodfacts.org/search'; // Search-a-licious, the primary Open Food Facts search
const OFF_LEGACY = 'world.openfoodfacts.org/cgi/search.pl'; // classic search, fallback only
const USER = '11111111-2222-4333-8444-555555555555';

const fdcFood = (
  fdcId: number,
  gtinUpc: string | null,
  description = 'GREEK YOGURT',
  kcal = 59,
) => ({
  fdcId,
  description,
  dataType: 'Branded',
  gtinUpc,
  brandName: 'FAGE',
  foodNutrients: [
    { nutrientId: 1008, unitName: 'KCAL', value: kcal },
    { nutrientId: 1003, unitName: 'G', value: 10 },
    { nutrientId: 1005, unitName: 'G', value: 4 },
    { nutrientId: 1004, unitName: 'G', value: 0.4 },
  ],
});

const offFood = (code: string, name = 'Greek yogurt', extra: Record<string, unknown> = {}) => ({
  code,
  product_name: name,
  brands: 'Fage,Total',
  nutriments: { 'energy-kcal_100g': 97, proteins_100g: 9, carbohydrates_100g: 4, fat_100g: 5 },
  ...extra,
});

function setup(
  handlers: Array<[string, Handler]>,
  over: Partial<OnlineSearchDeps> & { waits?: number[] } = {},
) {
  const net = fakeFetch(handlers);
  const waits = [...(over.waits ?? [])];
  const consumeRateLimit = vi.fn(async () => waits.shift() ?? 0);
  const deps: OnlineSearchDeps = {
    fetch: net.fn,
    env: { FDC_API_KEY: 'fdc-key', OFF_USER_AGENT: 'cal-track-test/1.0' },
    userId: USER,
    consumeRateLimit,
    log: vi.fn(),
    ...over,
  };
  return { deps, net, consumeRateLimit };
}

const fdcOk = (foods: unknown[]): [string, Handler] => [FDC, () => json({ foods })];
const offOk = (products: unknown[]): [string, Handler] => [
  OFF,
  () => json({ count: products.length, hits: products }),
];
const offLegacyOk = (products: unknown[]): [string, Handler] => [
  OFF_LEGACY,
  () => json({ count: products.length, products }),
];

describe('onlineSearch', () => {
  describe('request validation', () => {
    it.each([
      ['no body', null],
      ['missing query', {}],
      ['non-string query', { query: 5 }],
      ['too short', { query: ' a ' }],
      ['blank', { query: '   ' }],
      ['too long', { query: 'x'.repeat(101) }],
    ])('400 for %s, before rate limiting or any upstream call', async (_l, body) => {
      const t = setup([]);
      const res = await onlineSearch(body, t.deps);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: expect.stringMatching(/invalid_/) });
      expect(t.consumeRateLimit).not.toHaveBeenCalled();
      expect(t.net.calls).toHaveLength(0);
    });

    it.each([['abc'], [0], [-3], [Number.NaN], [{}]])('400 for limit %j', async (limit) => {
      const t = setup([]);
      const res = await onlineSearch({ query: 'yogurt', limit }, t.deps);
      expect(res.status).toBe(400);
    });

    it('clamps limit to 20, floors fractions, defaults to 10', async () => {
      const pageSizes = async (body: unknown) => {
        const t = setup([fdcOk([]), offOk([])]);
        await onlineSearch(body, t.deps);
        return t.net.calls.map(
          (c) =>
            new URL(c.url).searchParams.get('pageSize') ??
            new URL(c.url).searchParams.get('page_size'),
        );
      };
      // FDC asks for `limit`; Search-a-licious for twice that (many of its products have no nutrition data), capped at 50
      expect(await pageSizes({ query: 'yogurt' })).toEqual(['10', '20']);
      expect(await pageSizes({ query: 'yogurt', limit: 500 })).toEqual(['20', '40']);
      expect(await pageSizes({ query: 'yogurt', limit: 7.9 })).toEqual(['7', '14']);
      expect(await pageSizes({ query: 'yogurt', limit: null })).toEqual(['10', '20']);
    });
  });

  describe('upstream requests', () => {
    it('queries FDC Branded and OFF search with the documented URLs', async () => {
      const t = setup([fdcOk([]), offOk([])]);
      await onlineSearch({ query: '  greek   yogurt & honey ', limit: 5 }, t.deps);
      expect(t.net.calls).toHaveLength(2);

      const fdc = new URL(t.net.calls.find((c) => c.url.includes(FDC))!.url);
      expect(fdc.origin + fdc.pathname).toBe('https://api.nal.usda.gov/fdc/v1/foods/search');
      expect(Object.fromEntries(fdc.searchParams)).toEqual({
        query: 'greek yogurt & honey',
        dataType: 'Branded',
        pageSize: '5',
        api_key: 'fdc-key',
      });

      const offCall = t.net.calls.find((c) => c.url.includes(OFF))!;
      const off = new URL(offCall.url);
      expect(off.origin + off.pathname).toBe('https://search.openfoodfacts.org/search');
      expect(Object.fromEntries(off.searchParams)).toEqual({
        q: 'greek yogurt & honey',
        page_size: '10',
        fields:
          'code,product_name,brands,nutriments,serving_size,serving_quantity,quantity,countries_tags,categories_tags_en,nutrition_data_per',
      });
      expect((offCall.init!.headers as Record<string, string>)['User-Agent']).toBe(
        'cal-track-test/1.0',
      );
    });

    it('uses the default User-Agent and skips FDC without a key', async () => {
      const t = setup([offOk([])], { env: {} });
      const res = await onlineSearch({ query: 'yogurt' }, t.deps);
      expect(res.status).toBe(200);
      expect(t.net.calls).toHaveLength(1);
      expect((t.net.calls[0]!.init!.headers as Record<string, string>)['User-Agent']).toBe(
        DEFAULT_OFF_USER_AGENT,
      );
      expect(res.body).toEqual({ query: 'yogurt', results: [] }); // a skipped source is not a warning
    });
  });

  describe('merging', () => {
    it('returns summaries only, de-duplicated by GTIN-14 and interleaved', async () => {
      const t = setup([
        fdcOk([
          fdcFood(1, '036000291452', 'FDC ONE'), // same product as OFF 0036000291452
          fdcFood(2, '011111111113', 'FDC TWO'),
          fdcFood(3, null, 'NO BARCODE'), // dropped: cannot be looked up
        ]),
        offOk([
          offFood('0036000291452', 'OFF one', {
            nutriments: {
              'energy-kcal_100g': 90,
              proteins_100g: 9,
              carbohydrates_100g: 4,
              fat_100g: 5,
              sugars_100g: 3,
              salt_100g: 0.1,
            },
          }),
          offFood('4006381333931', 'OFF two'),
          offFood('5000000000000', 'OFF no nutrition', { nutriments: {} }), // dropped
        ]),
      ]);
      const res = await onlineSearch({ query: 'yogurt' }, t.deps);
      expect(res.status).toBe(200);
      const body = res.body as { query: string; results: SearchSummary[] };
      expect(body.query).toBe('yogurt');
      // interleaved: fdc[0] (replaced by the more complete OFF twin), off[1]... see order below
      expect(body.results.map((r) => r.gtin14)).toEqual([
        '00036000291452',
        '00011111111113',
        '04006381333931',
      ]);
      // the OFF record has more nutrients (sugars + sodium) -> more complete -> wins the duplicate
      expect(body.results[0]).toMatchObject({ name: 'OFF one', source: 'off' });
      expect(body.results[1]).toMatchObject({
        name: 'Fdc Two',
        source: 'fdc_branded',
        brand: 'Fage',
      });
      expect(Object.keys(body.results[0]!).sort()).toEqual(
        [
          'brand',
          'carbs100g',
          'completeness',
          'fat100g',
          'gtin14',
          'kcal100g',
          'name',
          'protein100g',
          'source',
        ].sort(),
      );
    });

    it('summary values come from the cleaned per-100 g nutrients', async () => {
      const t = setup([fdcOk([fdcFood(1, '036000291452', 'GREEK YOGURT', 59.4321)]), offOk([])]);
      const res = await onlineSearch({ query: 'yogurt' }, t.deps);
      expect((res.body as { results: SearchSummary[] }).results[0]).toEqual({
        gtin14: '00036000291452',
        name: 'Greek Yogurt',
        brand: 'Fage',
        source: 'fdc_branded',
        kcal100g: 59.43,
        protein100g: 10,
        carbs100g: 4,
        fat100g: 0.4,
        completeness: expect.any(Number),
      });
    });

    it('caps the merged list at limit', async () => {
      const fdc = Array.from({ length: 5 }, (_, i) =>
        fdcFood(i + 1, `0360002914${i}2`.slice(0, 12), `F${i}`),
      );
      const off = Array.from({ length: 5 }, (_, i) => offFood(`40063813339${i}1`, `O${i}`));
      const t = setup([fdcOk(fdc), offOk(off)]);
      const res = await onlineSearch({ query: 'yogurt', limit: 4 }, t.deps);
      const names = (res.body as { results: SearchSummary[] }).results.map((r) => r.name);
      expect(names).toEqual(['F0', 'O0', 'F1', 'O1']);
    });

    it('mergeResults keeps the earlier record on equal completeness', () => {
      const mk = (
        source: 'off' | 'fdc_branded',
        name: string,
        completeness: number,
      ): SearchSummary => ({
        gtin14: '00000000000001',
        name,
        brand: null,
        source,
        kcal100g: 1,
        protein100g: 1,
        carbs100g: 1,
        fat100g: 1,
        completeness,
      });
      expect(
        mergeResults([[mk('fdc_branded', 'a', 0.1)], [mk('off', 'b', 0.1)]], 5).map((r) => r.name),
      ).toEqual(['a']);
      expect(
        mergeResults([[mk('fdc_branded', 'a', 0.1)], [mk('off', 'b', 0.2)]], 5).map((r) => r.name),
      ).toEqual(['b']);
      expect(mergeResults([], 5)).toEqual([]);
    });

    it('summarize drops rejected / barcode-less products', () => {
      expect(summarize({ ok: false, reason: 'x' })).toBeNull();
      expect(
        summarize({
          ok: true,
          product: {
            source: 'off',
            sourceId: '1',
            gtin14: null,
            name: 'x',
            brand: null,
            category: null,
            nutrients: { ENERGY_KCAL: 1 },
            carbBasis: 'excludes_fiber',
            serving: null,
          },
        }),
      ).toBeNull();
    });
  });

  describe('partial failures', () => {
    it('returns the healthy source plus a warning when the other is rate limited or down', async () => {
      const off429: [string, Handler] = [OFF, () => json({}, 429, { 'Retry-After': '30' })];
      const a = setup([fdcOk([fdcFood(1, '036000291452')]), off429]);
      const ra = await onlineSearch({ query: 'yogurt' }, a.deps);
      expect(ra.status).toBe(200);
      expect(ra.body).toMatchObject({ warnings: [{ source: 'off', error: 'rate_limited' }] });
      expect((ra.body as { results: unknown[] }).results).toHaveLength(1);

      const fdc500: [string, Handler] = [FDC, () => json({}, 500)];
      const b = setup([fdc500, offOk([offFood('4006381333931')])]);
      const rb = await onlineSearch({ query: 'yogurt' }, b.deps);
      expect(rb.status).toBe(200);
      expect(rb.body).toMatchObject({
        warnings: [{ source: 'fdc_branded', error: 'upstream_error' }],
      });
    });

    it('429 when every usable source is rate limited, 502 when they simply fail', async () => {
      const limited = setup([
        [FDC, () => json({}, 429, { 'Retry-After': '120' })],
        [OFF, () => json({}, 429, { 'Retry-After': '30' })],
      ]);
      const r1 = await onlineSearch({ query: 'yogurt' }, limited.deps);
      expect(r1.status).toBe(429);
      expect(r1.body).toMatchObject({ error: 'rate_limited', retryAfterSeconds: 120 });

      const down = setup([
        [FDC, () => json({}, 500)],
        [OFF, () => Promise.reject(new Error('net'))],
      ]);
      const r2 = await onlineSearch({ query: 'yogurt' }, down.deps);
      expect(r2.status).toBe(502);
      expect(r2.body).toMatchObject({ error: 'upstream_error' });

      const offOnlyDown = setup([[OFF, () => json({}, 500)]], { env: {} });
      expect((await onlineSearch({ query: 'yogurt' }, offOnlyDown.deps)).status).toBe(502);
    });
  });

  describe('Open Food Facts fallback', () => {
    it('uses the classic search when Search-a-licious answers 503 (the cloud-IP failure seen in production)', async () => {
      const t = setup(
        [[OFF, () => json({}, 503)], offLegacyOk([offFood('4006381333931', 'Classic hit')])],
        { env: {} },
      );
      const res = await onlineSearch({ query: 'yogurt' }, t.deps);
      expect(res.status).toBe(200);
      expect((res.body as { results: SearchSummary[] }).results.map((r) => r.name)).toEqual(['Classic hit']);
      expect(res.body).not.toHaveProperty('warnings');
      expect(t.net.calls.map((c) => new URL(c.url).hostname)).toEqual([
        'search.openfoodfacts.org',
        'world.openfoodfacts.org',
      ]);
    });

    it('does not call the classic search when Search-a-licious works', async () => {
      const t = setup([offOk([offFood('4006381333931')])], { env: {} });
      await onlineSearch({ query: 'yogurt' }, t.deps);
      expect(t.net.calls).toHaveLength(1);
    });

    it('502 only when both Open Food Facts APIs fail', async () => {
      const t = setup([[OFF, () => json({}, 503)], [OFF_LEGACY, () => json({}, 503)]], { env: {} });
      const res = await onlineSearch({ query: 'yogurt' }, t.deps);
      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({ error: 'upstream_error' });
    });

    it('keeps the retry time when Search-a-licious is rate limited and the classic search is down', async () => {
      const t = setup(
        [[OFF, () => json({}, 429, { 'Retry-After': '45' })], [OFF_LEGACY, () => json({}, 503)]],
        { env: {} },
      );
      const res = await onlineSearch({ query: 'yogurt' }, t.deps);
      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({ retryAfterSeconds: 45 });
    });

    it('accepts brands as an array (Search-a-licious) and as a comma separated string (classic)', async () => {
      const t = setup(
        [offOk([offFood('4006381333931', 'Array brands', { brands: ['Fage', 'Total'] })])],
        { env: {} },
      );
      const res = await onlineSearch({ query: 'yogurt' }, t.deps);
      expect((res.body as { results: SearchSummary[] }).results[0]).toMatchObject({
        name: 'Array brands',
        brand: 'Fage',
      });
    });
  });

  describe('throttling', () => {
    it('consumes the per-user and the global bucket before calling upstream', async () => {
      const t = setup([fdcOk([]), offOk([])]);
      await onlineSearch({ query: 'yogurt' }, t.deps);
      expect(t.consumeRateLimit.mock.calls).toEqual([
        [USER, SEARCH_BUCKET, DEFAULT_SEARCH_LIMITS.perUser, DEFAULT_SEARCH_LIMITS.windowSeconds],
        [
          GLOBAL_RATE_LIMIT_USER,
          GLOBAL_SEARCH_BUCKET,
          DEFAULT_SEARCH_LIMITS.global,
          DEFAULT_SEARCH_LIMITS.windowSeconds,
        ],
      ]);
      expect(DEFAULT_SEARCH_LIMITS).toEqual({ perUser: 5, global: 8, windowSeconds: 60 });
    });

    it('honours custom limits', async () => {
      const t = setup([fdcOk([]), offOk([])], {
        limits: { perUser: 2, global: 3, windowSeconds: 30 },
      });
      await onlineSearch({ query: 'yogurt' }, t.deps);
      expect(t.consumeRateLimit.mock.calls.map((c) => c.slice(2))).toEqual([
        [2, 30],
        [3, 30],
      ]);
    });

    it('429 with retryAfterSeconds when the user bucket is exhausted (no upstream calls, no global consumption)', async () => {
      const t = setup([], { waits: [17] });
      const res = await onlineSearch({ query: 'yogurt' }, t.deps);
      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({
        error: 'rate_limited',
        retryAfterSeconds: 17,
        scope: 'user',
      });
      expect(res.headers).toEqual({ 'Retry-After': '17' });
      expect(t.net.calls).toHaveLength(0);
      expect(t.consumeRateLimit).toHaveBeenCalledTimes(1);
    });

    it('429 scope global when the shared OFF budget is used up', async () => {
      const t = setup([], { waits: [0, 9] });
      const res = await onlineSearch({ query: 'yogurt' }, t.deps);
      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({ retryAfterSeconds: 9, scope: 'global' });
      expect(t.net.calls).toHaveLength(0);
    });

    it('lets a limiter failure propagate (fail closed -> handleHttp 500)', async () => {
      const t = setup([], {
        consumeRateLimit: async () => {
          throw new Error('db down');
        },
      });
      await expect(onlineSearch({ query: 'yogurt' }, t.deps)).rejects.toThrow('db down');
    });
  });
});
