import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OpenRouterError } from './errors';
import { createOpenRouterClient, type ChatStreamEvent } from './openrouter';
import { chatBody, deltaChunk, jsonResponse, mockFetch, noSleep, recordingSleep, sseResponse } from './test-helpers';

const KEY = 'sk-or-v1-supersecretkey1234567890';

function client(fetchImpl: ReturnType<typeof mockFetch>['fetch'], extra: Record<string, unknown> = {}) {
  return createOpenRouterClient({
    apiKey: KEY,
    fetch: fetchImpl,
    appUrl: 'https://ration.example',
    appTitle: 'Ration',
    sleep: noSleep,
    random: () => 0.5,
    ...extra,
  });
}

async function collect(gen: AsyncGenerator<ChatStreamEvent, void, undefined>) {
  const events: ChatStreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

async function expectError(p: Promise<unknown>): Promise<OpenRouterError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OpenRouterError);
    return e as OpenRouterError;
  }
  throw new Error('expected rejection');
}

describe('chat request shape', () => {
  it('sends URL, headers and body', async () => {
    const m = mockFetch(jsonResponse(chatBody('hi')));
    const res = await client(m.fetch).chat({
      model: 'google/gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.3,
      maxTokens: 100,
    });
    expect(res.text).toBe('hi');
    expect(res.usage).toMatchObject({ promptTokens: 10, completionTokens: 5, totalTokens: 15, cost: 0.0001 });
    const call = m.calls[0]!;
    expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(call.method).toBe('POST');
    expect(call.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.headers['HTTP-Referer']).toBe('https://ration.example');
    expect(call.headers['X-Title']).toBe('Ration');
    expect(call.body).toEqual({
      model: 'google/gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.3,
      max_tokens: 100,
    });
  });

  it('uses the models array when fallbacks are given and de-duplicates', async () => {
    const m = mockFetch(jsonResponse(chatBody('ok')));
    await client(m.fetch).chat({
      model: 'a/one',
      models: ['a/one', 'b/two'],
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(m.calls[0]!.body.models).toEqual(['a/one', 'b/two']);
    expect(m.calls[0]!.body.model).toBeUndefined();
  });

  it('requires a model', async () => {
    const m = mockFetch(jsonResponse(chatBody('ok')));
    const err = await expectError(client(m.fetch).chat({ messages: [{ role: 'user', content: 'x' }] }));
    expect(err.kind).toBe('bad_request');
    expect(m.calls).toHaveLength(0);
  });

  it('fails fast without a key', async () => {
    const m = mockFetch(jsonResponse(chatBody('ok')));
    const c = createOpenRouterClient({ apiKey: '  ', fetch: m.fetch });
    const err = await expectError(c.chat({ model: 'a/b', messages: [{ role: 'user', content: 'x' }] }));
    expect(err.kind).toBe('auth');
    expect(m.calls).toHaveLength(0);
  });
});

describe('error mapping', () => {
  const cases: Array<[number, string, RegExp, boolean]> = [
    [401, 'auth', /key was rejected/i, false],
    [402, 'credits', /credits are exhausted.*openrouter\.ai\/credits/i, false],
    [403, 'moderation', /blocked/i, false],
    [408, 'timeout', /timed out/i, true],
    [429, 'rate_limit', /rate limit/i, true],
    [503, 'provider', /unavailable/i, true],
    [400, 'bad_request', /rejected the request/i, false],
  ];
  for (const [status, kind, msg, retryable] of cases) {
    it(`maps ${status} -> ${kind}`, async () => {
      const m = mockFetch(jsonResponse({ error: { code: status, message: `boom ${status}` } }, status));
      const err = await expectError(
        client(m.fetch, { maxRetries: 0 }).chat({ model: 'a/b', messages: [{ role: 'user', content: 'x' }] }),
      );
      expect(err.kind).toBe(kind);
      expect(err.status).toBe(status);
      expect(err.userMessage).toMatch(msg);
      expect(err.retryable).toBe(retryable);
    });
  }

  it('does not retry 401/402/403', async () => {
    for (const status of [401, 402, 403]) {
      const m = mockFetch(jsonResponse({ error: { message: 'no' } }, status));
      await expectError(client(m.fetch).chat({ model: 'a/b', messages: [{ role: 'user', content: 'x' }] }));
      expect(m.calls).toHaveLength(1);
    }
  });

  it('includes moderation reasons from metadata', async () => {
    const m = mockFetch(
      jsonResponse({ error: { code: 403, message: 'flagged', metadata: { reasons: ['violence'], flagged_input: 'x' } } }, 403),
    );
    const err = await expectError(client(m.fetch).chat({ model: 'a/b', messages: [{ role: 'user', content: 'x' }] }));
    expect(err.userMessage).toContain('violence');
  });

  it('gives a model-capability hint for "No endpoints found"', async () => {
    const m = mockFetch(jsonResponse({ error: { code: 404, message: 'No endpoints found that support image input' } }, 404));
    const err = await expectError(client(m.fetch).chat({ model: 'a/b', messages: [{ role: 'user', content: 'x' }] }));
    expect(err.kind).toBe('bad_request');
    expect(err.userMessage).toMatch(/Pick a different model/);
  });

  it('maps a 200 response that carries an error object', async () => {
    const m = mockFetch(jsonResponse({ error: { code: 429, message: 'slow down' } }));
    const err = await expectError(
      client(m.fetch, { maxRetries: 0 }).chat({ model: 'a/b', messages: [{ role: 'user', content: 'x' }] }),
    );
    expect(err.kind).toBe('rate_limit');
  });

  it('maps network failures and never leaks the key', async () => {
    const m = mockFetch(new TypeError(`fetch failed: Authorization: Bearer ${KEY}`));
    const err = await expectError(client(m.fetch).chat({ model: 'a/b', messages: [{ role: 'user', content: 'x' }] }));
    expect(err.kind).toBe('network');
    expect(err.retryable).toBe(true);
    expect(err.message).not.toContain(KEY);
    expect(JSON.stringify(err)).not.toContain(KEY);
    expect(err.userMessage).not.toContain(KEY);
  });

  it('redacts a key echoed back in an error body', async () => {
    const m = mockFetch(jsonResponse({ error: { code: 401, message: `Invalid key ${KEY}` } }, 401));
    const err = await expectError(client(m.fetch).chat({ model: 'a/b', messages: [{ role: 'user', content: 'x' }] }));
    expect(err.message).not.toContain(KEY);
  });

  it('times out when the server never answers', async () => {
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    const c = createOpenRouterClient({ apiKey: KEY, fetch: hang, timeoutMs: 20, sleep: noSleep });
    const err = await expectError(c.chat({ model: 'a/b', messages: [{ role: 'user', content: 'x' }] }));
    expect(err.kind).toBe('timeout');
    expect(err.retryable).toBe(true);
  });

  it('propagates a caller abort as AbortError', async () => {
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    const controller = new AbortController();
    const c = createOpenRouterClient({ apiKey: KEY, fetch: hang, sleep: noSleep });
    const p = c.chat({ model: 'a/b', messages: [{ role: 'user', content: 'x' }], signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('retry and backoff', () => {
  const req = { model: 'a/b', messages: [{ role: 'user' as const, content: 'x' }] };

  it('honours Retry-After on 429', async () => {
    const { sleep, delays } = recordingSleep();
    const m = mockFetch(
      jsonResponse({ error: { message: 'rl' } }, 429, { 'retry-after': '2' }),
      jsonResponse(chatBody('done')),
    );
    const res = await client(m.fetch, { sleep }).chat(req);
    expect(res.text).toBe('done');
    expect(delays).toEqual([2000]);
    expect(m.calls).toHaveLength(2);
  });

  it('uses exponential backoff with jitter for 503 and stops after 2 retries', async () => {
    const { sleep, delays } = recordingSleep();
    const m = mockFetch(jsonResponse({ error: { message: 'down' } }, 503));
    const err = await expectError(client(m.fetch, { sleep, random: () => 0.5 }).chat(req));
    expect(err.kind).toBe('provider');
    expect(m.calls).toHaveLength(3);
    // base 500 * 2^attempt * (0.5 + 0.5 * 0.5)
    expect(delays).toEqual([375, 750]);
  });

  it('retries 408 and recovers', async () => {
    const { sleep, delays } = recordingSleep();
    const m = mockFetch(jsonResponse({ error: { message: 't' } }, 408), jsonResponse(chatBody('ok')));
    const res = await client(m.fetch, { sleep }).chat(req);
    expect(res.text).toBe('ok');
    expect(delays).toHaveLength(1);
  });

  it('does not wait for an excessive Retry-After', async () => {
    const { sleep, delays } = recordingSleep();
    const m = mockFetch(jsonResponse({ error: { message: 'rl' } }, 429, { 'retry-after': '3600' }));
    const err = await expectError(client(m.fetch, { sleep }).chat(req));
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(3_600_000);
    expect(delays).toEqual([]);
    expect(m.calls).toHaveLength(1);
  });
});

describe('streaming', () => {
  const req = { model: 'a/b', messages: [{ role: 'user' as const, content: 'x' }] };

  it('streams deltas, ignores SSE comments and reports usage', async () => {
    const m = mockFetch(
      sseResponse([
        ': OPENROUTER PROCESSING\n\n',
        deltaChunk('Hel'),
        // a JSON line split across two network chunks
        `data: {"id":"gen-1","choices":[{"index":0,"delta":{"con`,
        `tent":"lo"},"finish_reason":null}]}\n\n`,
        ': OPENROUTER PROCESSING\n\n',
        `data: ${JSON.stringify({
          id: 'gen-1',
          choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        })}\n\n`,
        'data: [DONE]\n\n',
      ]),
    );
    const events = await collect(client(m.fetch).chatStream(req));
    const text = events.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('');
    expect(text).toBe('Hello');
    const done = events.at(-1)!;
    expect(done).toMatchObject({ type: 'done', finishReason: 'stop', usage: { totalTokens: 5 } });
    expect(m.calls[0]!.body.stream).toBe(true);
    expect(m.calls[0]!.headers.Accept).toBe('text/event-stream');
  });

  it('throws on a mid-stream error chunk after yielding earlier text (HTTP status was 200)', async () => {
    const m = mockFetch(
      sseResponse([
        deltaChunk('Part'),
        `data: ${JSON.stringify({
          id: 'gen-1',
          error: { code: 'server_error', message: 'Provider disconnected unexpectedly' },
          choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
        })}\n\n`,
      ]),
    );
    const seen: string[] = [];
    let thrown: unknown;
    try {
      for await (const e of client(m.fetch).chatStream(req)) if (e.type === 'delta') seen.push(e.text);
    } catch (e) {
      thrown = e;
    }
    expect(seen).toEqual(['Part']);
    expect(thrown).toBeInstanceOf(OpenRouterError);
    expect((thrown as OpenRouterError).kind).toBe('provider');
    expect((thrown as OpenRouterError).retryable).toBe(true);
  });

  it('maps numeric mid-stream error codes (429 -> rate_limit)', async () => {
    const m = mockFetch(sseResponse([`data: ${JSON.stringify({ error: { code: 429, message: 'rl' } })}\n\n`]));
    const err = await expectError(collect(client(m.fetch).chatStream(req)));
    expect(err.kind).toBe('rate_limit');
  });

  it('retries HTTP errors that occur before the stream starts', async () => {
    const { sleep, delays } = recordingSleep();
    const m = mockFetch(
      jsonResponse({ error: { message: 'rl' } }, 429),
      sseResponse([deltaChunk('ok'), 'data: [DONE]\n\n']),
    );
    const events = await collect(client(m.fetch, { sleep }).chatStream(req));
    expect(events.some((e) => e.type === 'delta')).toBe(true);
    expect(delays).toHaveLength(1);
  });

  it('falls back to reading the whole body when response.body is not streamable', async () => {
    const payload = `${deltaChunk('Whole')}${deltaChunk(' body')}data: [DONE]\n\n`;
    const fake = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: null,
      text: async () => payload,
    } as unknown as Response;
    const m = mockFetch(() => fake);
    const events = await collect(client(m.fetch).chatStream(req));
    expect(events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')).toBe('Whole body');
  });

  it('stream:false uses a normal request and yields one delta', async () => {
    const m = mockFetch(jsonResponse(chatBody('full answer')));
    const events = await collect(client(m.fetch).chatStream({ ...req, stream: false }));
    expect(events[0]).toEqual({ type: 'delta', text: 'full answer' });
    expect(events[1]).toMatchObject({ type: 'done' });
    expect(m.calls[0]!.body.stream).toBeUndefined();
  });

  it('aborts the connection when the consumer stops early', async () => {
    const m = mockFetch(sseResponse([deltaChunk('a'), deltaChunk('b'), 'data: [DONE]\n\n']));
    for await (const e of client(m.fetch).chatStream(req)) {
      if (e.type === 'delta') break;
    }
    expect(m.calls[0]!.signal?.aborted).toBe(true);
  });

  it('fails when the stream carries no data at all', async () => {
    const m = mockFetch(sseResponse([': OPENROUTER PROCESSING\n\n']));
    const err = await expectError(collect(client(m.fetch).chatStream(req)));
    expect(err.kind).toBe('provider');
  });
});

describe('chatJson', () => {
  const Schema = z.object({
    name: z.string(),
    grams: z.number().min(0).max(1000),
    note: z.string().optional(),
  });

  it('sends strict json_schema + require_parameters and parses the reply', async () => {
    const m = mockFetch(jsonResponse(chatBody('{"name":"egg","grams":50}')));
    const out = await client(m.fetch).chatJson({
      model: 'a/b',
      jsonSchemaName: 'my schema!',
      schema: Schema,
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 300,
    });
    expect(out).toEqual({ name: 'egg', grams: 50 });
    const body = m.calls[0]!.body;
    expect(body.provider).toEqual({ require_parameters: true });
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.name).toBe('my_schema_');
    const schema = body.response_format.json_schema.schema;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['name', 'grams', 'note']);
    expect(schema.properties.note.type).toEqual(['string', 'null']);
    expect(schema.properties.grams.maximum).toBeUndefined();
    expect(schema.properties.grams.description).toContain('max 1000');
    expect(schema.$schema).toBeUndefined();
    expect(body.max_tokens).toBe(300);
  });

  it("optionalFields:'omit' keeps optional properties out of required", async () => {
    const m = mockFetch(jsonResponse(chatBody('{"name":"egg","grams":50}')));
    await client(m.fetch).chatJson({
      model: 'a/b',
      jsonSchemaName: 's',
      schema: Schema,
      optionalFields: 'omit',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(m.calls[0]!.body.response_format.json_schema.schema.required).toEqual(['name', 'grams']);
  });

  it('strips markdown fences and accepts null for optional fields', async () => {
    const m = mockFetch(jsonResponse(chatBody('```json\n{"name":"egg","grams":50,"note":null}\n```')));
    const out = await client(m.fetch).chatJson({
      model: 'a/b',
      jsonSchemaName: 's',
      schema: Schema,
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(out).toEqual({ name: 'egg', grams: 50 });
    expect(m.calls).toHaveLength(1);
  });

  it('puts the text part first and the image after it, leaving the system message alone', async () => {
    const m = mockFetch(jsonResponse(chatBody('{"name":"egg","grams":50}')));
    await client(m.fetch).chatJson({
      model: 'a/b',
      jsonSchemaName: 's',
      schema: Schema,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'What is this?' },
      ],
      images: [{ base64: 'AAAA', mimeType: 'image/jpeg' }],
    });
    const msgs = m.calls[0]!.body.messages;
    expect(msgs[0]).toEqual({ role: 'system', content: 'sys' });
    expect(msgs[1].content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
    ]);
  });

  it('repairs once: second request carries the invalid reply and the validation error', async () => {
    const m = mockFetch(
      jsonResponse(chatBody('{"name":"egg","grams":"lots"}')),
      jsonResponse(chatBody('{"name":"egg","grams":50}')),
    );
    const out = await client(m.fetch).chatJson({
      model: 'a/b',
      jsonSchemaName: 's',
      schema: Schema,
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(out.grams).toBe(50);
    expect(m.calls).toHaveLength(2);
    const second = m.calls[1]!.body.messages;
    expect(second.at(-2)).toEqual({ role: 'assistant', content: '{"name":"egg","grams":"lots"}' });
    expect(second.at(-1).role).toBe('user');
    expect(second.at(-1).content).toMatch(/grams/);
    expect(second.at(-1).content).toMatch(/ONLY a single JSON/);
  });

  it('throws invalid_output after the single repair attempt fails', async () => {
    const m = mockFetch(jsonResponse(chatBody('not json at all')), jsonResponse(chatBody('{"name":1}')));
    const err = await expectError(
      client(m.fetch).chatJson({
        model: 'a/b',
        jsonSchemaName: 's',
        schema: Schema,
        messages: [{ role: 'user', content: 'x' }],
      }),
    );
    expect(err.kind).toBe('invalid_output');
    expect(m.calls).toHaveLength(2);
  });

  it('turns a structured-output refusal into a moderation error', async () => {
    const m = mockFetch(
      jsonResponse({
        id: 'x',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: null, refusal: "I can't help with that" } }],
      }),
    );
    const err = await expectError(
      client(m.fetch).chatJson({
        model: 'a/b',
        jsonSchemaName: 's',
        schema: Schema,
        messages: [{ role: 'user', content: 'x' }],
      }),
    );
    expect(err.kind).toBe('moderation');
  });
});

describe('getKeyInfo', () => {
  it('GETs /key with the bearer token and normalises the payload', async () => {
    const m = mockFetch(
      jsonResponse({
        data: {
          label: 'sk-or-v1-abc...xyz',
          limit: 10,
          limit_remaining: 7.5,
          limit_reset: null,
          usage: 2.5,
          usage_daily: 0.5,
          usage_monthly: 2.5,
          is_free_tier: false,
          is_management_key: false,
          expires_at: null,
          free_model_daily_requests: { limit: 50, remaining: 40, used: 10 },
        },
      }),
    );
    const info = await client(m.fetch).getKeyInfo();
    expect(m.calls[0]!.url).toBe('https://openrouter.ai/api/v1/key');
    expect(m.calls[0]!.method).toBe('GET');
    expect(m.calls[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(info).toMatchObject({
      limit: 10,
      limitRemaining: 7.5,
      usage: 2.5,
      isFreeTier: false,
      freeModelDailyRequests: { limit: 50, remaining: 40, used: 10 },
    });
  });

  it('401 -> auth', async () => {
    const m = mockFetch(jsonResponse({ error: { code: 401, message: 'No auth credentials found' } }, 401));
    const err = await expectError(client(m.fetch).getKeyInfo());
    expect(err.kind).toBe('auth');
  });
});

describe('listModels', () => {
  const raw = [
    {
      id: 'google/gemini-2.5-flash',
      name: 'Gemini 2.5 Flash',
      created: 1750000000,
      context_length: 1048576,
      architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'] },
      pricing: { prompt: '0.0000003', completion: '0.0000025', image: '0.001238' },
      supported_parameters: ['temperature', 'structured_outputs', 'tools'],
    },
    {
      id: 'meta/text-only:free',
      name: 'Text only',
      context_length: 8000,
      architecture: { input_modalities: ['text'] },
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: ['temperature'],
    },
    {
      id: 'openrouter/auto',
      name: 'Auto Router',
      context_length: 2000000,
      architecture: { modality: 'text+image->text' },
      pricing: { prompt: '-1', completion: 'NaN' },
      supported_parameters: [],
    },
    { name: 'no id' },
  ];

  it('builds the query and converts prices to USD per million tokens', async () => {
    const m = mockFetch(jsonResponse({ data: raw }));
    const models = await client(m.fetch).listModels({
      imageInput: true,
      structuredOutputs: true,
      sort: 'newest',
      q: 'gemini flash',
      limit: 50,
      maxPromptPricePerM: 2,
    });
    expect(m.calls[0]!.url).toBe(
      'https://openrouter.ai/api/v1/models?input_modalities=text,image&supported_parameters=structured_outputs&sort=newest&q=gemini%20flash&limit=50&max_price=2',
    );
    expect(m.calls[0]!.headers.Authorization).toBeUndefined();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: 'google/gemini-2.5-flash',
      name: 'Gemini 2.5 Flash',
      contextLength: 1048576,
      inputModalities: ['text', 'image'],
      supportsImages: true,
      supportsStructuredOutputs: true,
      supportsTools: true,
      promptPricePerM: 0.3,
      completionPricePerM: 2.5,
      imagePricePerK: 1.238,
      isFree: false,
    });
  });

  it('normalises without filters: modality fallback, free detection, bad prices -> null', async () => {
    const m = mockFetch(jsonResponse({ data: raw }));
    const models = await client(m.fetch).listModels();
    expect(m.calls[0]!.url).toBe('https://openrouter.ai/api/v1/models');
    expect(models.map((x) => x.id)).toEqual(['google/gemini-2.5-flash', 'meta/text-only:free', 'openrouter/auto']);
    const free = models[1]!;
    expect(free.isFree).toBe(true);
    expect(free.supportsImages).toBe(false);
    expect(free.promptPricePerM).toBe(0);
    const auto = models[2]!;
    expect(auto.supportsImages).toBe(true); // derived from "text+image->text"
    expect(auto.promptPricePerM).toBeNull();
    expect(auto.completionPricePerM).toBeNull();
    expect(auto.isFree).toBe(false);
  });
});
