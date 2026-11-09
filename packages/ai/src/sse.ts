/**
 * Minimal, dependency-free Server-Sent Events parser.
 *
 * - Handles \n, \r\n and \r line endings and chunk boundaries anywhere.
 * - Comment lines (starting with ':', e.g. ': OPENROUTER PROCESSING') are ignored.
 * - Multiple `data:` lines in one event are joined with '\n'.
 */

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

export interface SseParser {
  /** Feed a decoded text chunk; returns the events completed by it. */
  feed(chunk: string): SseEvent[];
  /** Flush a trailing event that was not terminated by a blank line. */
  flush(): SseEvent[];
}

export function createSseParser(): SseParser {
  let buffer = '';
  let dataLines: string[] = [];
  let eventName: string | undefined;
  let eventId: string | undefined;
  let hasData = false;

  const dispatch = (out: SseEvent[]): void => {
    if (hasData) {
      out.push({ data: dataLines.join('\n'), event: eventName, id: eventId });
    }
    dataLines = [];
    eventName = undefined;
    eventId = undefined;
    hasData = false;
  };

  const processLine = (line: string, out: SseEvent[]): void => {
    if (line === '') {
      dispatch(out);
      return;
    }
    if (line.startsWith(':')) return; // comment / keep-alive
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'data':
        dataLines.push(value);
        hasData = true;
        break;
      case 'event':
        eventName = value;
        break;
      case 'id':
        eventId = value;
        break;
      default:
        break; // retry / unknown fields ignored
    }
  };

  return {
    feed(chunk: string): SseEvent[] {
      const out: SseEvent[] = [];
      buffer += chunk;
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const ch = buffer[i];
        if (ch === '\n' || ch === '\r') {
          // A trailing '\r' might be the first half of '\r\n': wait for more data.
          if (ch === '\r' && i === buffer.length - 1) break;
          processLine(buffer.slice(start, i), out);
          if (ch === '\r' && buffer[i + 1] === '\n') i++;
          start = i + 1;
        }
      }
      buffer = buffer.slice(start);
      return out;
    },
    flush(): SseEvent[] {
      const out: SseEvent[] = [];
      if (buffer.length > 0) {
        processLine(buffer.replace(/\r$/, ''), out);
        buffer = '';
      }
      dispatch(out);
      return out;
    },
  };
}
