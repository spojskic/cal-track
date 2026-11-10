import { describe, expect, it } from 'vitest';
import { GarminError } from './errors';
import { formatSyncReport } from './report';
import type { GarminReply } from './client';
import { runGarminSync, type GarminSyncSource } from './sync';

const ok = (data: unknown): GarminReply => ({ status: 200, empty: false, data });

// Distinctive values: none of them may ever appear in the report.
const SENTINELS = ['7316', '2763', '1829', '4271', '73.456', '12345678901', 'SECRET-DISPLAY-NAME', 'Sveta Anna 10K', '8.99', '53219'];

const client: GarminSyncSource = {
  profile: async () => ok({ displayName: 'SECRET-DISPLAY-NAME', fullName: 'X' }),
  userSummary: async (_n, date) =>
    date === '2026-11-09'
      ? ok({ totalKilocalories: 2763, activeKilocalories: 1829, bmrKilocalories: 934, totalSteps: 53219, restingHeartRate: 400 })
      : ok({ restingHeartRate: 52, totalSteps: 7316 }),
  sleep: async () => ok({ dailySleepDTO: { sleepTimeSeconds: 32000, sleepScores: { overall: { value: 81 } } } }),
  hrv: async () => ok({ hrvSummary: { lastNightAvg: 4271, status: 'BALANCED' } }),
  weightRange: async () => ok({ dateWeightList: [{ samplePk: 1, calendarDate: '2026-11-09', weight: 73456.0 }, { calendarDate: '2026-11-08', weight: 3 }] }),
  activities: async () => ok([{ activityId: 12345678901, activityName: 'Sveta Anna 10K', startTimeLocal: '2026-11-09 07:00:00', duration: 1800, calories: 8.99, activityType: { typeKey: 'running' } }]),
};

async function report(source: GarminSyncSource = client) {
  const outcome = await runGarminSync({
    client: source,
    range: { from: '2026-11-08', to: '2026-11-10' },
    onBatch: async () => undefined,
    now: (() => {
      let t = 1_000;
      return () => (t += 500);
    })(),
  });
  return { outcome, text: formatSyncReport(outcome.report, { generatedAtMs: Date.UTC(2026, 10, 10, 12), app: 'Cal Track 0.1.0 (ios)' }, outcome.counts) };
}

describe('formatSyncReport', () => {
  it('lists the endpoints, outcomes and fields without a single value, id or name', async () => {
    const { text } = await report();
    for (const s of SENTINELS) expect(text, s).not.toContain(s);
    expect(text).toContain('Cal Track - Garmin sync report');
    expect(text).toContain('Generated: 2026-11-10T12:00:00.000Z');
    expect(text).toContain('App: Cal Track 0.1.0 (ios)');
    expect(text).toContain('Range: 2026-11-08 to 2026-11-10 (3 days)');
    expect(text).toContain('all GET, nothing is written to Garmin');
  });

  it('says per endpoint what was asked and what came back', async () => {
    const { text } = await report();
    expect(text).toContain('profile: /userprofile-service/socialProfile');
    expect(text).toContain('userSummary: /usersummary-service/usersummary/daily/{displayName}?calendarDate={date}');
    expect(text).toContain('hrv: /hrv-service/hrv/{date}');
    expect(text).toMatch(/3 requests: ok 3; with data: 3/);
  });

  it('names the JSON key that matched each field', async () => {
    const { text } = await report();
    expect(text).toContain('steps: found 3 of 3 via totalSteps');
    expect(text).toContain('sleepScore: found 3 of 3 via dailySleepDTO.sleepScores.overall.value');
  });

  it('lists the fields that were NOT found, with every key that was tried', async () => {
    const { text } = await report();
    expect(text).toMatch(/Fields NOT found: .*userSummary\.stress/);
    expect(text).toContain('stress: NOT FOUND in 3 replies (tried: averageStressLevel, stress.avgLevel, avgStressLevel)');
    expect(text).toContain('bodyBatteryHigh: NOT FOUND');
  });

  it('prints mapper notes without the numbers behind them', async () => {
    const { text } = await report();
    expect(text).toContain('Mapper notes');
    expect(text).toContain('userSummary.restingHeartRate: implausible x1');
    expect(text).toContain('weight.weight: implausible x1');
    expect(text).not.toContain('400');
  });

  it('says how the run ended, with Retry-After for a 429', async () => {
    const limited: GarminSyncSource = { ...client, userSummary: async () => { throw new GarminError({ kind: 'rate_limited', status: 429, retryAfterSeconds: 45 }); } };
    const { text } = await report(limited);
    expect(text).toContain('Result: STOPPED at userSummary: rate_limited (Retry-After 45 s)');
    expect(text).toContain('rate limited (HTTP 429) 1');
    const finished = await report();
    expect(finished.text).toContain('Result: finished');
  });

  it('never carries a token, a ticket or a bearer header, even when Garmin\'s error text echoes one', async () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjF9.c2lnbmF0dXJl';
    const leaky: GarminSyncSource = {
      ...client,
      hrv: async () => {
        throw new GarminError({ kind: 'http', status: 418, message: `teapot Bearer ${jwt} ticket=ST-1-abcdef refresh_token=zzzzzzzz` });
      },
    };
    const { text } = await report(leaky);
    for (const secret of [jwt, 'ST-1-abcdef', 'zzzzzzzz', 'Bearer eyJ']) expect(text, secret).not.toContain(secret);
    expect(text).toContain('hrv: /hrv-service/hrv/{date}');
  });

  it('is deterministic for the same input', async () => {
    const a = await report();
    const b = await report();
    expect(a.text).toBe(b.text);
  });
});
