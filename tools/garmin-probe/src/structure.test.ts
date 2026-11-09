import { describe, expect, it } from 'vitest';
import { listKeyPaths, mergeStructures, numberPlaceholder, stringPlaceholder, summarizeStructure } from './structure';

describe('placeholders', () => {
  it('numbers keep magnitude but not value', () => {
    expect(numberPlaceholder(72500)).toBe('<int:5d>');
    expect(numberPlaceholder(72.5)).toBe('<float:2d>');
    expect(numberPlaceholder(0.182)).toBe('<float:1d>');
    expect(numberPlaceholder(0)).toBe('<int:1d>');
    expect(numberPlaceholder(1762670400000)).toBe('<int:13d>');
    expect(numberPlaceholder(-1)).toBe('<int:-1d>');
    expect(numberPlaceholder(NaN)).toBe('<number:nonfinite>');
    expect(numberPlaceholder(9.99)).toBe('<float:1d>');
    expect(numberPlaceholder(10)).toBe('<int:2d>');
  });
  it('strings keep only their format', () => {
    expect(stringPlaceholder('2026-11-09')).toBe('<string:date>');
    expect(stringPlaceholder('2026-11-09 06:30:00')).toBe('<string:datetime-space>');
    expect(stringPlaceholder('2026-11-09T06:30:00.0')).toBe('<string:datetime-T>');
    expect(stringPlaceholder('2026-11-09T06:30:00.0Z')).toBe('<string:datetime-tz>');
    expect(stringPlaceholder('2026-11-09T06:30:00+01:00')).toBe('<string:datetime-tz>');
    expect(stringPlaceholder('72.5')).toBe('<string:numeric>');
    expect(stringPlaceholder('')).toBe('<string:empty>');
    expect(stringPlaceholder('Morning Run')).toBe('<string>');
    expect(stringPlaceholder('BALANCED')).toBe('<string>');
  });
});

describe('summarizeStructure', () => {
  it('replaces every value, keeps keys', () => {
    const s = summarizeStructure({ calendarDate: '2026-11-09', weight: 72500, bmi: 23.4, ok: true, name: 'Sam', note: null, nested: { a: 1 } });
    expect(s).toEqual({ calendarDate: '<string:date>', weight: '<int:5d>', bmi: '<float:2d>', ok: '<boolean>', name: '<string>', note: null, nested: { a: '<int:1d>' } });
  });
  it('never leaks values into the output', () => {
    const secret = { name: 'Samir Pojskic', weight: 72345, hr: [51, 52, 53], when: '2026-11-09 06:30:00', nested: [{ id: 987654321 }] };
    const text = JSON.stringify(summarizeStructure(secret));
    for (const leak of ['Samir', 'Pojskic', '72345', '987654321', '06:30:00']) expect(text).not.toContain(leak);
  });
  it('describes arrays with length and a merged item', () => {
    const s = summarizeStructure({ data: [{ d: '2026-11-01', a: 1 }, { d: '2026-11-02', a: 2, b: 'x' }, { d: '2026-11-03', a: 3 }] });
    expect(s).toEqual({ data: { $array: '3', item: { d: '<string:date>', a: '<int:1d>', b: '<string>', $optional: ['b'] } } });
  });
  it('empty arrays, nulls and undefined', () => {
    expect(summarizeStructure([])).toEqual({ $array: '0' });
    expect(summarizeStructure(null)).toBeNull();
    expect(summarizeStructure(undefined)).toBeNull();
    expect(summarizeStructure({ a: undefined })).toEqual({ a: null });
  });
  it('short primitive arrays keep per-position types (body battery style)', () => {
    expect(summarizeStructure([1762670400000, 'MEASURED', 42, 2.0])).toEqual({ $array: '4', positions: ['<int:13d>', '<string>', '<int:2d>', '<int:1d>'] });
  });
  it('arrays of tuples merge positions', () => {
    const s = summarizeStructure({ v: [[1762670400000, 'MEASURED', 42, 2.0], [1762670460000, 'MEASURED', null, 2.0], [1762670520000, 'UNMEASURED', 40, 2.0]] });
    expect(s).toEqual({ v: { $array: '3', item: { $array: '4', positions: ['<int:13d>', '<string>', '<int:2d> | null', '<int:1d>'] } } });
  });
  it('long primitive arrays collapse to a merged item', () => {
    const s = summarizeStructure(Array.from({ length: 50 }, (_, i) => i));
    expect(s).toEqual({ $array: '50', item: '<int:1d> | <int:2d>' });
  });
  it('mixed kinds become $oneOf', () => {
    const s = summarizeStructure([{ a: 1 }, 'x', [1, 2], { b: 2 }, null, 5]);
    expect(s).toMatchObject({ $array: '6' });
    const item = (s as { item: { $oneOf: unknown[] } }).item;
    expect(item.$oneOf).toHaveLength(3);
  });
  it('handles cycles, deep nesting and exotic objects without throwing', () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    expect(summarizeStructure(a)).toEqual({ x: '<int:1d>', self: '<circular>' });
    let deep: unknown = 'leaf';
    for (let i = 0; i < 40; i++) deep = { n: deep };
    expect(JSON.stringify(summarizeStructure(deep))).toContain('<max-depth>');
    expect(summarizeStructure(new Date())).toBe('<object>');
    expect(summarizeStructure(() => 1)).toBe('<unsupported>');
    expect(summarizeStructure(10n)).toBe('<int>');
    expect(summarizeStructure(Symbol('s'))).toBe('<unsupported>');
  });
  it('samples huge arrays', () => {
    const big = Array.from({ length: 5000 }, () => ({ a: 1 }));
    const s = summarizeStructure(big) as { $array: string };
    expect(s.$array).toBe('5000');
  });
  it('is JSON-serialisable', () => {
    const s = summarizeStructure({ a: [1, { b: [] }], c: 'x' });
    expect(() => JSON.stringify(s)).not.toThrow();
  });
});

describe('mergeStructures', () => {
  it('merges primitives into a sorted union', () => {
    expect(mergeStructures(['<string>', '<int:1d>', '<string>'])).toBe('<int:1d> | <string>');
    expect(mergeStructures([null, null])).toBeNull();
    expect(mergeStructures([null, '<int:1d>'])).toBe('<int:1d> | null');
  });
  it('merges array length ranges', () => {
    const m = mergeStructures([{ $array: '2', item: '<int:1d>' }, { $array: '5', item: '<int:2d>' }]) as { $array: string; item: string };
    expect(m.$array).toBe('2-5');
    expect(m.item).toBe('<int:1d> | <int:2d>');
  });
  it('empty input', () => {
    expect(mergeStructures([])).toBeNull();
  });
});

describe('listKeyPaths', () => {
  it('lists readable key paths with types', () => {
    const s = summarizeStructure({
      dailySleepDTO: { calendarDate: '2026-11-09', sleepScores: { overall: { value: 82 } } },
      list: [{ a: 1, b: 'x' }, { a: 2 }],
      tuple: [1, 'x'],
    });
    const lines = listKeyPaths(s);
    expect(lines).toContain('dailySleepDTO.calendarDate: <string:date>');
    expect(lines).toContain('dailySleepDTO.sleepScores.overall.value: <int:2d>');
    expect(lines).toContain('list[] (length 2)');
    expect(lines).toContain('list[].a: <int:1d>');
    expect(lines).toContain('list[].b?: <string>');
    expect(lines).toContain('tuple[] (length 2)');
    expect(lines).toContain('tuple[0]: <int:1d>');
    expect(lines).toContain('tuple[1]: <string>');
  });
  it('handles a bare primitive, empty object and empty array', () => {
    expect(listKeyPaths('<int:1d>')).toEqual(['$: <int:1d>']);
    expect(listKeyPaths({})).toEqual(['$: {}']);
    expect(listKeyPaths({ $array: '0' })).toEqual(['$[] (length 0)']);
    expect(listKeyPaths(null)).toEqual(['$: null']);
  });
});
