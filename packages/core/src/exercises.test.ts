import { describe, expect, it } from 'vitest';
import { exerciseKcalNetMet } from './energy';
import {
  EXERCISE_CATEGORIES,
  MET_ACTIVITIES,
  MET_ACTIVITY_BY_CODE,
  searchActivities,
} from './exercises';

describe('MET activities', () => {
  it('has about 60+ unique activities', () => {
    expect(MET_ACTIVITIES.length).toBeGreaterThanOrEqual(60);
    const codes = MET_ACTIVITIES.map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
    const names = MET_ACTIVITIES.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('uses UPPER_SNAKE codes, known categories and plausible METs', () => {
    for (const a of MET_ACTIVITIES) {
      expect(a.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(EXERCISE_CATEGORIES).toContain(a.category);
      expect(a.met).toBeGreaterThanOrEqual(1.5);
      expect(a.met).toBeLessThanOrEqual(23);
      expect(a.name.length).toBeGreaterThan(3);
    }
    for (const category of EXERCISE_CATEGORIES) {
      expect(MET_ACTIVITIES.some((a) => a.category === category), category).toBe(true);
    }
  });

  it('orders walking and running by intensity', () => {
    const met = (code: string) => MET_ACTIVITY_BY_CODE.get(code)?.met as number;
    expect(met('WALK_SLOW')).toBeLessThan(met('WALK_NORMAL'));
    expect(met('WALK_NORMAL')).toBeLessThan(met('WALK_BRISK'));
    expect(met('WALK_BRISK')).toBeLessThan(met('WALK_VERY_BRISK'));
    expect(met('RUN_5_MPH')).toBeLessThan(met('RUN_6_MPH'));
    expect(met('RUN_6_MPH')).toBeLessThan(met('RUN_7_5_MPH'));
    expect(met('RUN_7_5_MPH')).toBeLessThan(met('RUN_9_MPH'));
    expect(met('RUN_9_MPH')).toBeLessThan(met('RUN_10_MPH'));
    expect(met('CYCLE_LIGHT')).toBeLessThan(met('CYCLE_MODERATE'));
    expect(met('CYCLE_MODERATE')).toBeLessThan(met('CYCLE_VIGOROUS'));
    expect(met('WEIGHTS_LIGHT')).toBeLessThan(met('WEIGHTS_VIGOROUS'));
  });

  it('includes the requested activity families', () => {
    for (const code of [
      'WALK_UPHILL', 'HIKING', 'SWIM_LAPS_LIGHT', 'SWIM_LAPS_VIGOROUS', 'ROW_MACHINE_MODERATE',
      'ELLIPTICAL', 'STAIR_MACHINE', 'HIIT', 'CIRCUIT_VIGOROUS', 'YOGA_HATHA', 'PILATES',
      'STRETCHING', 'BASKETBALL_GAME', 'SOCCER_CASUAL', 'TENNIS_SINGLES', 'FOOTBALL_TOUCH',
      'VOLLEYBALL_BEACH', 'MARTIAL_ARTS', 'BOXING_BAG', 'JUMP_ROPE_MODERATE', 'SKI_DOWNHILL',
      'CLIMBING_ROCK', 'HOUSEWORK_VACUUM', 'GARDENING_GENERAL',
    ]) {
      expect(MET_ACTIVITY_BY_CODE.has(code), code).toBe(true);
    }
  });

  it('feeds the net-MET energy formula: running 6 mph, 70 kg, 30 min', () => {
    const met = MET_ACTIVITY_BY_CODE.get('RUN_6_MPH')?.met as number;
    // (9.8 - 1) * 70 * 0.5 = 308
    expect(exerciseKcalNetMet(met, 70, 30)).toBeCloseTo(308, 8);
  });

  it('searches by name and category', () => {
    expect(searchActivities('yoga').map((a) => a.code).sort()).toEqual(['YOGA_HATHA', 'YOGA_POWER']);
    expect(searchActivities('WINTER').length).toBeGreaterThan(3);
    expect(searchActivities('zzzz')).toEqual([]);
    expect(searchActivities('', 5)).toHaveLength(5);
  });
});
