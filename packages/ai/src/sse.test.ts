import { describe, expect, it } from 'vitest';
import { createSseParser } from './sse';

function parseAll(chunks: string[]) {
  const p = createSseParser();
  const out = chunks.flatMap((c) => p.feed(c));
  out.push(...p.flush());
  return out;
}

describe('sse parser', () => {
  it('parses simple events', () => {
    expect(parseAll(['data: {"a":1}\n\ndata: [DONE]\n\n']).map((e) => e.data)).toEqual(['{"a":1}', '[DONE]']);
  });

  it('skips comment lines such as OPENROUTER PROCESSING', () => {
    const events = parseAll([': OPENROUTER PROCESSING\n\n', ': keep-alive\ndata: {"x":2}\n\n']);
    expect(events.map((e) => e.data)).toEqual(['{"x":2}']);
  });

  it('handles chunk boundaries inside a line and CRLF endings', () => {
    const events = parseAll(['da', 'ta: {"a"', ':1}\r', '\n\r', '\ndata: two\r\n\r\n']);
    expect(events.map((e) => e.data)).toEqual(['{"a":1}', 'two']);
  });

  it('joins multi-line data and flushes an unterminated trailing event', () => {
    const events = parseAll(['data: a\ndata: b\n\ndata: tail']);
    expect(events.map((e) => e.data)).toEqual(['a\nb', 'tail']);
  });

  it('keeps event name and ignores unknown fields', () => {
    const events = parseAll(['event: ping\nretry: 10\ndata: x\n\n']);
    expect(events).toEqual([{ event: 'ping', data: 'x', id: undefined }]);
  });
});
