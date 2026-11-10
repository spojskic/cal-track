import { describe, expect, it } from 'vitest';
import { GARMIN_BASE_URL, GARMIN_BASE_URL_CN, TOKEN_PATH, type FetchInit, type ResponseLike } from '@cal/garmin';
import type { ProbeArgs } from './args';
import { RAW_WARNING, runProbe, type ProbeIO } from './run';

const KEY = 'GCDC_PROBESECRET0123456789';
const b64url = (s: string): string => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const NOW = new Date(2026, 10, 10, 12, 0, 0); // local
const JWT = `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify({ exp: Math.floor(NOW.getTime() / 1000) + 86400 }))}.sig`;

const baseArgs = (over: Partial<ProbeArgs> = {}): ProbeArgs => ({
  days: 3,
  outDir: '/out',
  raw: false,
  mapped: false,
  endpoints: ['dailySummaries', 'sleep', 'activities', 'hydration'],
  cn: false,
  help: false,
  ...over,
});

const res = (status: number, body: unknown = ''): ResponseLike => ({
  status,
  headers: { get: (n) => (n.toLowerCase() === 'content-type' && typeof body !== 'string' ? 'application/json' : null) },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

interface Seen {
  url: string;
  init: FetchInit;
}

function world(overrides: Record<string, (url: string) => ResponseLike> = {}) {
  const seen: Seen[] = [];
  const fetch = async (url: string, init: FetchInit): Promise<ResponseLike> => {
    seen.push({ url, init });
    for (const [frag, h] of Object.entries(overrides)) if (url.includes(frag)) return h(url);
    if (url.endsWith(TOKEN_PATH)) return res(200, JWT);
    if (url.includes('/userprofile/settings')) return res(200, { displayName: 'Sam Example', timeZone: 'Europe/Sarajevo' });
    if (url.includes('/v2/dailysummaries')) {
      return res(200, { data: ['2026-11-08', '2026-11-09', '2026-11-10'].map((d) => ({ calendarDate: d, totalKilocalories: 2650, activeKilocalories: 612, totalSteps: 9876, restingHeartRate: 52, averageStressLevel: 31 })) });
    }
    if (url.includes('dailySleepSummariesByDate')) {
      return res(200, [{ calendarDate: '2026-11-10', sleepTimeSeconds: 27123, deepSleepSeconds: 5400, sleepScores: { overall: { value: 82 } } }]);
    }
    if (url.includes('activities/search')) {
      return res(200, [{ activityId: 987654321, activityName: 'Morning Run', startTimeGMT: '2026-11-09 06:30:00', duration: 2701.2, calories: 612, activityType: { typeKey: 'running' } }]);
    }
    return res(204);
  };
  return { fetch, seen };
}

function memoryIO() {
  const logs: string[] = [];
  const files = new Map<string, string>();
  const io: ProbeIO = {
    log: (l) => logs.push(l),
    mkdir: async () => undefined,
    writeFile: async (p, c) => void files.set(p, c),
  };
  return { io, logs, files, text: () => logs.join('\n'), fileText: () => [...files.values()].join('\n') };
}

const run = (args: ProbeArgs, w = world(), m = memoryIO(), apiKey: string | null = KEY) =>
  runProbe({ args, apiKey: apiKey ?? undefined, io: m.io, fetch: w.fetch, now: () => NOW, sleep: async () => undefined }).then((code) => ({ code, w, m }));

describe('runProbe', () => {
  it('needs the key in the environment', async () => {
    const { code, w, m } = await run(baseArgs(), world(), memoryIO(), null);
    expect(code).toBe(2);
    expect(w.seen).toHaveLength(0);
    expect(m.text()).toContain('GARMIN_PERSONAL_API_KEY');
    const blank = await run(baseArgs(), world(), memoryIO(), '   ');
    expect(blank.code).toBe(2);
  });
  it('reports a rejected key with the friendly message and writes nothing', async () => {
    const { code, m } = await run(baseArgs(), world({ [TOKEN_PATH]: () => res(401, { errorId: 'X' }) }));
    expect(code).toBe(1);
    expect(m.text()).toContain('Garmin rejected this key');
    expect(m.files.size).toBe(0);
  });
  it('writes structure files, report and key paths (structure-only by default)', async () => {
    const { code, m } = await run(baseArgs());
    expect(code).toBe(0);
    const names = [...m.files.keys()].map((k) => k.replace('/out/', ''));
    expect(names).toContain('dailySummaries__2026-11-08_2026-11-10.structure.json');
    expect(names).toContain('sleep__2026-11-08_2026-11-10.structure.json');
    expect(names).toContain('activities__2026-11-08_2026-11-10__p0.structure.json');
    expect(names).toContain('hydration__2026-11-08_2026-11-10.structure.json');
    expect(names).toContain('report.txt');
    expect(names).toContain('structure-paths.txt');
    expect(names.some((n) => n.endsWith('.raw.json'))).toBe(false);
    const sum = JSON.parse(m.files.get('/out/dailySummaries__2026-11-08_2026-11-10.structure.json')!);
    expect(sum.request).toEqual({ path: '/usersummary-service/v2/dailysummaries', params: { startDate: '2026-11-08', endDate: '2026-11-10' } });
    expect(sum.structure.data.item.calendarDate).toBe('<string:date>');
    expect(sum.structure.data.item.totalKilocalories).toBe('<int:4d>');
  });
  it('structure-only output contains no values', async () => {
    const { m } = await run(baseArgs({ endpoints: ['userSettings', 'dailySummaries', 'sleep', 'activities'] }));
    const written = m.fileText();
    for (const leak of ['Sam Example', 'Morning Run', '987654321', '27123', '2650', '9876', 'Europe/Sarajevo']) expect(written).not.toContain(leak);
  });
  it('the key and the token never appear in console output or files', async () => {
    const w = world({ 'dailySleepSummariesByDate': () => res(500, { message: `boom ${KEY} ${JWT}` }) });
    const { m } = await run(baseArgs(), w);
    const everything = `${m.text()}\n${m.fileText()}`;
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain(JWT);
    expect(m.text()).toContain('ERROR server HTTP 500');
  });
  it('--raw writes raw values and warns loudly (start and end)', async () => {
    const { m } = await run(baseArgs({ raw: true, endpoints: ['sleep', 'activities'] }));
    const raw = m.files.get('/out/activities__2026-11-08_2026-11-10__p0.raw.json')!;
    expect(raw).toContain('Morning Run');
    expect(m.text().split(RAW_WARNING).length - 1).toBe(2);
    expect(m.text()).toContain('RAW VALUES');
    expect(m.text()).not.toContain('contain key names, types and number sizes, but no values');
  });
  it('structure-only run explains what to share', async () => {
    const { m } = await run(baseArgs());
    expect(m.text()).toContain('report.txt');
    expect(m.text()).toContain('no values');
  });
  it('--mapped prints the normalized output', async () => {
    const { m } = await run(baseArgs({ mapped: true, endpoints: ['dailySummaries', 'activities'] }));
    const t = m.text();
    expect(t).toContain('Mapped output');
    expect(t).toContain('"activeKcal": 612');
    expect(t).toContain('garmin:activity:987654321');
  });
  it('prints which fields the mappers found and which not', async () => {
    const { m } = await run(baseArgs({ endpoints: ['dailySummaries'] }));
    const t = m.text();
    expect(t).toMatch(/activeKcal\s+3\/3\s+activeKilocalories \(3\)/);
    expect(t).toMatch(/restingKcal\s+0\/3\s+NOT FOUND/);
    expect(t).toMatch(/none of: .*bmrKilocalories/);
    expect(m.files.get('/out/report.txt')).toContain('NOT FOUND');
  });
  it('--endpoints limits the requests and the range follows --days', async () => {
    const { w } = await run(baseArgs({ days: 1, endpoints: ['sleep'] }));
    const dataCalls = w.seen.filter((s) => !s.url.endsWith(TOKEN_PATH) && !s.url.includes('/userprofile/'));
    expect(dataCalls).toHaveLength(1);
    expect(dataCalls[0]!.url).toContain('startDate=2026-11-10&endDate=2026-11-10');
    expect(dataCalls[0]!.init.headers.Accept).toBe('*/*');
  });
  it('per-day endpoints look at the last 7 days at most', async () => {
    const { w } = await run(baseArgs({ days: 30, endpoints: ['spo2Day'] }));
    const calls = w.seen.filter((s) => s.url.includes('spo2acclimation'));
    expect(calls).toHaveLength(7);
    expect(calls[0]!.url).toContain('2026-11-04');
    expect(calls[6]!.url).toContain('2026-11-10');
  });
  it('uses the China host with --cn', async () => {
    const w = world();
    await run(baseArgs({ cn: true, endpoints: ['sleep'] }), w);
    expect(w.seen[0]!.url.startsWith(GARMIN_BASE_URL_CN)).toBe(true);
    expect(w.seen.some((s) => s.url.startsWith(GARMIN_BASE_URL + '/'))).toBe(false);
  });
  it('records empty (204) responses', async () => {
    const { m } = await run(baseArgs({ endpoints: ['hrv'] }));
    const doc = JSON.parse(m.files.get('/out/hrv__2026-11-08_2026-11-10.structure.json')!);
    expect(doc.empty).toBe(true);
    expect(doc.structure).toBeNull();
    expect(m.text()).toContain('empty response');
  });
  it('non-fatal endpoint failures are reported and the probe continues', async () => {
    const w = world({ 'activities/search': () => res(500, { errorId: 'E' }) });
    const { code, m } = await run(baseArgs(), w);
    expect(code).toBe(0);
    expect(m.text()).toContain('ERROR server HTTP 500');
    expect(m.files.has('/out/dailySummaries__2026-11-08_2026-11-10.structure.json')).toBe(true);
  });
  it('a missing scope (403) is reported without stopping', async () => {
    const w = world({ dailySleepSummariesByDate: () => res(403, { errorId: 'FORBIDDEN' }) });
    const { code, m } = await run(baseArgs(), w);
    expect(code).toBe(0);
    expect(m.text()).toContain('permission');
  });
  it('stops with exit code 1 on a persistent 401', async () => {
    const w = world({ 'v2/dailysummaries': () => res(401, {}) });
    const { code, m } = await run(baseArgs(), w);
    expect(code).toBe(1);
    expect(m.text()).toContain('Stopped:');
  });
  it('a profile read failure does not stop the probe', async () => {
    const w = world({ '/userprofile/settings': () => res(403) });
    const { code, m } = await run(baseArgs({ endpoints: ['sleep'] }), w);
    expect(code).toBe(0);
    expect(m.text()).toContain('the profile read failed');
  });
});
