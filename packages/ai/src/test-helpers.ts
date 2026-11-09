/** Test-only helpers (not exported from index). */

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
  signal?: AbortSignal | null;
}

export type FetchHandler =
  | Response
  | Error
  | ((call: RecordedCall) => Response | Promise<Response>);

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** SSE response whose body is delivered in exactly the given text chunks. */
export function sseResponse(chunks: string[], status = 200): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * Sequential mock fetch: the n-th call uses the n-th handler (the last handler
 * repeats). `calls` records URL, headers and parsed JSON body.
 */
export function mockFetch(...handlers: FetchHandler[]) {
  const calls: RecordedCall[] = [];
  const fn = async (input: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(rawHeaders)) headers[k] = v;
    const call: RecordedCall = {
      url: input,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      signal: init?.signal,
    };
    calls.push(call);
    const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    if (handler === undefined) throw new Error('mockFetch: no handler');
    if (handler instanceof Error) throw handler;
    if (typeof handler === 'function') return handler(call);
    // Response bodies can be read once: clone so a repeated last handler works.
    return handler.clone();
  };
  return { fetch: fn, calls };
}

export function chatBody(text: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'gen-1',
    model: 'test/model',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0001 },
    ...extra,
  };
}

export function deltaChunk(content: string): string {
  return `data: ${JSON.stringify({
    id: 'gen-1',
    model: 'test/model',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`;
}

export const noSleep = async (): Promise<void> => {};

export function recordingSleep() {
  const delays: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    delays.push(ms);
  };
  return { sleep, delays };
}
