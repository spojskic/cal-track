import { describe, expect, it } from 'vitest';
import { CHECKLIST_INITIAL, CHECKLIST_MORE, visibleHealthDataTypes } from '../../../apps/app/src/components/health/format';
import { HEALTH_DATA_TYPES } from '../../../apps/app/src/health/types';

// The "Connected Apps & Devices" checklist shows the first page of 5 data types and every tap on "Show more"
// reveals 5 more (components/health/format.ts). An ENABLED type is always visible: a ticked checkbox must not
// hide behind the fold, so the window extends to include it (and everything before it, order intact).
const ALL = HEALTH_DATA_TYPES;

describe('visibleHealthDataTypes', () => {
  it('the collapsed list opens with 2 rows; every Show more adds 5', () => {
    expect(CHECKLIST_INITIAL).toBe(2);
    expect(CHECKLIST_MORE).toBe(5);
  });

  it('collapsed with nothing enabled: the first 2 of 9', () => {
    expect(visibleHealthDataTypes(ALL, [], 0)).toEqual(ALL.slice(0, 2));
  });

  it('one tap on Show more: 5 more rows (7 of 9)', () => {
    expect(visibleHealthDataTypes(ALL, [], 1)).toEqual(ALL.slice(0, 7));
  });

  it('two taps: all 9', () => {
    expect(visibleHealthDataTypes(ALL, [], 2)).toEqual(ALL);
  });

  it('an enabled type beyond the fold pulls the window out to include it', () => {
    expect(visibleHealthDataTypes(ALL, ['resting_heart_rate'], 0)).toEqual(ALL.slice(0, 4));
    expect(visibleHealthDataTypes(ALL, ['sleep'], 0)).toEqual(ALL.slice(0, 8));
    expect(visibleHealthDataTypes(ALL, ['blood_pressure'], 0)).toEqual(ALL);
  });

  it('enabled types inside the first page change nothing', () => {
    expect(visibleHealthDataTypes(ALL, ['activity', 'weight'], 0)).toEqual(ALL.slice(0, 2));
  });

  it('an enabled type just past the fold pulls in everything before it', () => {
    expect(visibleHealthDataTypes(ALL, ['body_fat'], 0)).toEqual(ALL.slice(0, 3));
  });

  it('an over-expanded page count never goes past the end', () => {
    expect(visibleHealthDataTypes(ALL, [], 7)).toEqual(ALL);
  });
});
