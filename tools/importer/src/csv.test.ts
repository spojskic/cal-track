import { describe, expect, it } from 'vitest';
import {
  compactKey,
  decodeBytes,
  detectEncoding,
  field,
  parseDecimal,
  readCsv,
  readCsvFile,
  resolveEncodingFlag,
  sniffDelimiter,
} from './csv';
import { memorySource } from './source';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

async function* chunks(text: string, size = 5): AsyncGenerator<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

describe('compactKey / field / parseDecimal', () => {
  it('normalises header names', () => {
    expect(compactKey('\uFEFFFood ID')).toBe('foodid');
    expect(compactKey('fdc_id')).toBe('fdcid');
    expect(compactKey('NDB_number')).toBe('ndbnumber');
    expect(compactKey('NumberofObservations')).toBe('numberofobservations');
  });

  it('field returns the first non-empty alias, trimmed', () => {
    expect(field({ a: '  ', b: ' x ' }, 'a', 'b')).toBe('x');
    expect(field({}, 'a')).toBe('');
  });

  it('parses decimals strictly', () => {
    expect(parseDecimal('1.5')).toBe(1.5);
    expect(parseDecimal(' 0 ')).toBe(0);
    expect(parseDecimal('1,5')).toBe(1.5);
    expect(parseDecimal('1e2')).toBe(100);
    expect(parseDecimal('-3')).toBe(-3);
    expect(parseDecimal('')).toBeNull();
    expect(parseDecimal('abc')).toBeNull();
    expect(parseDecimal('12abc')).toBeNull();
    expect(parseDecimal('NaN')).toBeNull();
    expect(parseDecimal('Infinity')).toBeNull();
    expect(parseDecimal(undefined)).toBeNull();
  });
});

describe('readCsv', () => {
  it('streams RFC4180 quoted rows split across arbitrary chunk boundaries', async () => {
    const csv = '"fdc_id","description"\n"1","Milk, ""whole"""\n"2","multi\nline"\n';
    const rows = await collect(readCsv(chunks(csv, 3)));
    expect(rows).toEqual([
      { fdcid: '1', description: 'Milk, "whole"' },
      { fdcid: '2', description: 'multi\nline' },
    ]);
  });

  it('tolerates short rows, blank lines and stray quotes', async () => {
    const csv = 'a,b,c\n1,2\n\n3,4"5,6\n';
    const rows = await collect(readCsv(chunks(csv)));
    expect(rows[0]).toMatchObject({ a: '1', b: '2' });
    expect(rows[1]).toMatchObject({ a: '3', b: '4"5', c: '6' });
  });

  it('sniffs the delimiter from the header line', async () => {
    expect(sniffDelimiter('a;b;c')).toBe(';');
    expect(sniffDelimiter('a\tb\tc')).toBe('\t');
    expect(sniffDelimiter('"a,b";c;d')).toBe(';');
    expect(sniffDelimiter('abc')).toBe(',');
    const rows = await collect(readCsv(chunks('FoodID;Name\n1;Brot\n'), { delimiter: 'auto' }));
    expect(rows).toEqual([{ foodid: '1', name: 'Brot' }]);
  });
});

describe('encodings', () => {
  it('maps --encoding values', () => {
    expect(resolveEncodingFlag(undefined)).toBe('auto');
    expect(resolveEncodingFlag('UTF8')).toBe('utf-8');
    expect(resolveEncodingFlag('latin1')).toBe('windows-1252');
    expect(resolveEncodingFlag('ISO-8859-1')).toBe('windows-1252');
    expect(() => resolveEncodingFlag('ebcdic')).toThrow(/Unsupported/);
  });

  it('detects UTF-8 BOM, plain UTF-8, UTF-16LE BOM and latin1', async () => {
    const bytes = async function* (b: Buffer) {
      yield b;
    };
    expect(await detectEncoding(bytes(Buffer.from([0xef, 0xbb, 0xbf, 0x61])))).toBe('utf-8');
    expect(await detectEncoding(bytes(Buffer.from('Crème', 'utf8')))).toBe('utf-8');
    expect(await detectEncoding(bytes(Buffer.from('Crème', 'latin1')))).toBe('windows-1252');
    expect(await detectEncoding(bytes(Buffer.from([0xff, 0xfe, 0x61, 0x00])))).toBe('utf-16le');
  });

  it('detects invalid UTF-8 even when a multi-byte sequence is split across chunks', async () => {
    const utf8 = Buffer.from('é', 'utf8'); // c3 a9
    const split = async function* () {
      yield utf8.subarray(0, 1);
      yield utf8.subarray(1);
    };
    expect(await detectEncoding(split())).toBe('utf-8');
  });

  it('decodes latin1 and strips a UTF-8 BOM', async () => {
    const latin = await collect(decodeBytes([Buffer.from('Café µg', 'latin1')], 'windows-1252'));
    expect(latin.join('')).toBe('Café µg');
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('FoodID,Name\n', 'utf8')]);
    const text = await collect(decodeBytes([bom], 'utf-8'));
    expect(text.join('')).toBe('FoodID,Name\n');
  });

  it('readCsvFile auto-detects latin1 and BOM files and matches headers with spaces', async () => {
    const src = memorySource({
      'latin.csv': Buffer.from('Food ID,Food Description\n1,Café crème\n', 'latin1'),
      'bom.csv': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('"FoodID","FoodDescription"\n2,Crème\n', 'utf8')]),
    });
    expect(await collect(readCsvFile(src, 'latin.csv', { encoding: 'auto' }))).toEqual([
      { foodid: '1', fooddescription: 'Café crème' },
    ]);
    expect(await collect(readCsvFile(src, 'bom.csv', { encoding: 'auto' }))).toEqual([
      { foodid: '2', fooddescription: 'Crème' },
    ]);
  });

  it('an explicit --encoding utf8 on latin1 bytes does not silently succeed', async () => {
    const src = memorySource({ 'x.csv': Buffer.from('a,b\nCafé,1\n', 'latin1') });
    const rows = await collect(readCsvFile(src, 'x.csv', { encoding: 'utf8' }));
    expect(rows[0]?.a).not.toBe('Café'); // replacement character, not the real text
  });
});
