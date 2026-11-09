/**
 * OpenRouter client (bring-your-own-key, fully client side).
 *
 * - Runs on Node 22, browsers and React Native (Hermes): only `fetch`,
 *   `AbortController`, `TextDecoder`, `setTimeout`. Inject `fetch` (React
 *   Native should pass `expo/fetch` so `response.body` streams work).
 * - The API key lives only in the closure of the returned object. It is never
 *   logged, never stored and never placed in error messages.
 */

import type { z } from 'zod';
import {
  AbortError,
  OpenRouterError,
  errorFromBodyError,
  errorFromResponse,
  isAbortError,
  isOpenRouterError,
  parseRetryAfter,
  redactSecrets,
} from './errors';
import { imageInputToPart } from './image';
import { parseJsonLoose, stripNulls, summarizeIssues, toStrictJsonSchema } from './json-schema';
import { createSseParser, type SseEvent } from './sse';
import type {
  ChatContentPart,
  ChatMessage,
  ChatUsage,
  ImageInput,
  KeyInfo,
  ModelInfo,
} from './types';

export { OpenRouterError } from './errors';
export type { OpenRouterErrorKind } from './errors';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Subset of `fetch` the client needs. `typeof fetch` and `expo/fetch` (cast) both fit. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface OpenRouterClientOptions {
  apiKey: string;
  fetch?: FetchLike;
  baseUrl?: string;
  /** Sent as `HTTP-Referer` (shows on openrouter.ai rankings). Optional. */
  appUrl?: string;
  /** Sent as `X-Title`. Optional. */
  appTitle?: string;
  /** Per-request timeout; for streams it is the max time without any bytes. Default 60 000. */
  timeoutMs?: number;
  /** Automatic retries for 408/429/5xx. Default 2. */
  maxRetries?: number;
  /** Injectable for tests. */
  sleep?: SleepFn;
  /** Injectable jitter source for tests (returns [0,1)). */
  random?: () => number;
}

export interface ResponseFormatJsonSchema {
  type: 'json_schema';
  json_schema: { name: string; strict: boolean; schema: Record<string, unknown> };
}

export interface ChatRequest {
  /** Primary model id. */
  model?: string;
  /** Additional fallback models, tried in order after `model`. */
  models?: string[];
  messages: ChatMessage[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  responseFormat?: ResponseFormatJsonSchema | { type: 'json_object' };
  /** Only route to providers that support every parameter in the request. */
  requireParameters?: boolean;
  /** Extra OpenRouter provider preferences, merged with `requireParameters`. */
  provider?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Overrides the client timeout for this call. */
  timeoutMs?: number;
}

export interface ChatStreamRequest extends ChatRequest {
  /** Set false to skip streaming entirely and get a single delta from a normal call. */
  stream?: boolean;
}

export interface ChatResult {
  id?: string;
  model?: string;
  text: string;
  finishReason?: string | null;
  usage?: ChatUsage;
  /** Set when the model refused instead of answering (structured-output refusal). */
  refusal?: string;
}

export type ChatStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; usage?: ChatUsage; finishReason?: string | null; model?: string; id?: string };

export interface ChatJsonRequest<T> {
  messages: ChatMessage[];
  schema: z.ZodType<T>;
  /** Name sent in `response_format.json_schema.name` (letters, digits, `_`, `-`). */
  jsonSchemaName: string;
  model?: string;
  models?: string[];
  temperature?: number;
  maxTokens?: number;
  /** Attached to the LAST user message after its text part. */
  images?: ImageInput[];
  /**
   * How optional fields appear in the JSON Schema sent to the provider. 'nullable' (default) satisfies
   * strict mode everywhere; use 'omit' only if a model rejects nullable types.
   */
  optionalFields?: 'nullable' | 'omit';
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ListModelsOptions {
  /** Only models that accept image input. */
  imageInput?: boolean;
  /** Only models that support `response_format: json_schema`. */
  structuredOutputs?: boolean;
  sort?: string;
  q?: string;
  limit?: number;
  /** Max prompt price in USD per million tokens. */
  maxPromptPricePerM?: number;
  signal?: AbortSignal;
}

export interface OpenRouterClient {
  getKeyInfo(opts?: { signal?: AbortSignal }): Promise<KeyInfo>;
  listModels(opts?: ListModelsOptions): Promise<ModelInfo[]>;
  chat(req: ChatRequest): Promise<ChatResult>;
  chatStream(req: ChatStreamRequest): AsyncGenerator<ChatStreamEvent, void, undefined>;
  chatJson<T>(req: ChatJsonRequest<T>): Promise<T>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RETRY_AFTER_MS = 30_000;
const MAX_BACKOFF_MS = 8_000;

const defaultSleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function asRecord(v: unknown): Json | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asNullableNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asNullableString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function encodeQueryValue(v: string): string {
  return encodeURIComponent(v).replace(/%2C/gi, ',');
}

function buildQuery(params: Array<[string, string | number | undefined]>): string {
  const parts: string[] = [];
  for (const [k, v] of params) {
    if (v === undefined || v === '') continue;
    parts.push(`${k}=${encodeQueryValue(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

function sanitizeSchemaName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return cleaned.length ? cleaned : 'response';
}

export function normalizeUsage(raw: unknown): ChatUsage | undefined {
  const u = asRecord(raw);
  if (!u) return undefined;
  const usage: ChatUsage = {
    promptTokens: asNumber(u.prompt_tokens),
    completionTokens: asNumber(u.completion_tokens),
    totalTokens: asNumber(u.total_tokens),
    cost: asNumber(u.cost),
  };
  return usage;
}

/** Puts the images on the last user message, after its text part. Does not mutate the input. */
export function attachImagesToLastUserMessage(
  messages: ChatMessage[],
  images: ImageInput[] | undefined,
): ChatMessage[] {
  if (!images || images.length === 0) return messages;
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      idx = i;
      break;
    }
  }
  if (idx === -1) {
    throw new OpenRouterError({ kind: 'bad_request', message: 'Cannot attach images: no user message' });
  }
  const target = messages[idx] as ChatMessage;
  const existing: ChatContentPart[] =
    typeof target.content === 'string'
      ? target.content.length > 0
        ? [{ type: 'text', text: target.content }]
        : []
      : target.content;
  const texts = existing.filter((p) => p.type === 'text');
  const otherImages = existing.filter((p) => p.type !== 'text');
  const parts: ChatContentPart[] = [...texts, ...otherImages, ...images.map(imageInputToPart)];
  return messages.map((m, i) => (i === idx ? { role: m.role, content: parts } : m));
}

// ---------------------------------------------------------------------------
// model / key normalisation
// ---------------------------------------------------------------------------

function parsePrice(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function perMillion(perToken: number | null): number | null {
  return perToken === null ? null : Number((perToken * 1_000_000).toPrecision(10));
}

export function normalizeModel(raw: unknown): ModelInfo | null {
  const m = asRecord(raw);
  if (!m || typeof m.id !== 'string' || !m.id) return null;
  const arch = asRecord(m.architecture);
  const pricing = asRecord(m.pricing);
  const topProvider = asRecord(m.top_provider);

  let inputModalities: string[] = Array.isArray(arch?.input_modalities)
    ? (arch?.input_modalities as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  if (inputModalities.length === 0 && typeof arch?.modality === 'string') {
    // e.g. "text+image->text"
    const left = arch.modality.split('->')[0] ?? '';
    inputModalities = left.split('+').map((s) => s.trim()).filter(Boolean);
  }
  const supported = Array.isArray(m.supported_parameters)
    ? (m.supported_parameters as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];

  const promptPerToken = parsePrice(pricing?.prompt);
  const completionPerToken = parsePrice(pricing?.completion);
  const imagePerImage = parsePrice(pricing?.image);
  const id = m.id;
  const contextLength =
    asNumber(m.context_length) ?? asNumber(topProvider?.context_length) ?? 0;

  const info: ModelInfo = {
    id,
    name: typeof m.name === 'string' && m.name ? m.name : id,
    contextLength,
    inputModalities,
    supportsImages: inputModalities.includes('image'),
    supportsStructuredOutputs: supported.includes('structured_outputs'),
    supportsTools: supported.includes('tools'),
    promptPricePerM: perMillion(promptPerToken),
    completionPricePerM: perMillion(completionPerToken),
    imagePricePerK: imagePerImage === null ? null : Number((imagePerImage * 1000).toPrecision(10)),
    isFree:
      id.endsWith(':free') ||
      (promptPerToken !== null && completionPerToken !== null && promptPerToken === 0 && completionPerToken === 0),
  };
  const created = asNumber(m.created);
  if (created !== undefined) info.created = created;
  return info;
}

export function normalizeKeyInfo(raw: unknown): KeyInfo {
  const root = asRecord(raw);
  const d = asRecord(root?.data);
  if (!d) {
    throw new OpenRouterError({ kind: 'provider', message: 'Unexpected /key response shape' });
  }
  const free = asRecord(d.free_model_daily_requests);
  return {
    label: asNullableString(d.label),
    limit: asNullableNumber(d.limit),
    limitRemaining: asNullableNumber(d.limit_remaining),
    limitReset: asNullableString(d.limit_reset),
    usage: asNumber(d.usage) ?? 0,
    usageDaily: asNumber(d.usage_daily) ?? 0,
    usageMonthly: asNumber(d.usage_monthly) ?? 0,
    isFreeTier: d.is_free_tier === true,
    isManagementKey: d.is_management_key === true,
    expiresAt: asNullableString(d.expires_at),
    freeModelDailyRequests: free
      ? {
          limit: asNullableNumber(free.limit),
          remaining: asNullableNumber(free.remaining),
          used: asNullableNumber(free.used),
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// abort / timeout linking
// ---------------------------------------------------------------------------

interface Link {
  readonly signal: AbortSignal;
  readonly timedOut: boolean;
  arm(ms: number): void;
  disarm(): void;
  abort(): void;
  cleanup(): void;
}

function createLink(user: AbortSignal | undefined, timeoutMs: number): Link {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onUserAbort = (): void => controller.abort();

  if (user) {
    if (user.aborted) controller.abort();
    else user.addEventListener('abort', onUserAbort, { once: true });
  }

  const disarm = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const arm = (ms: number): void => {
    disarm();
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
  };
  arm(timeoutMs);

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    arm,
    disarm,
    abort: () => controller.abort(),
    cleanup: () => {
      disarm();
      user?.removeEventListener('abort', onUserAbort);
    },
  };
}

function classifyThrown(e: unknown, link: Link, user: AbortSignal | undefined, apiKey: string): Error {
  if (user?.aborted) return new AbortError();
  if (link.timedOut) return new OpenRouterError({ kind: 'timeout', message: 'Request timed out' });
  if (isOpenRouterError(e)) return e;
  if (isAbortError(e)) return new AbortError();
  const message = e instanceof Error ? e.message : String(e);
  return new OpenRouterError({
    kind: 'network',
    message: `Network error: ${redactSecrets(message, apiKey)}`,
    cause: undefined,
  });
}

function tryParseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// chat response parsing
// ---------------------------------------------------------------------------

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        const part = asRecord(p);
        return part && typeof part.text === 'string' ? part.text : '';
      })
      .join('');
  }
  return '';
}

export function parseChatResponse(json: unknown, apiKey?: string): ChatResult {
  const root = asRecord(json);
  if (!root) throw new OpenRouterError({ kind: 'provider', message: 'Empty chat response' });
  if (root.error) throw errorFromBodyError({ error: root.error }, apiKey);
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const choice = asRecord(choices[0]);
  if (!choice) throw new OpenRouterError({ kind: 'provider', message: 'Chat response has no choices' });
  if (choice.error) throw errorFromBodyError({ error: choice.error }, apiKey);
  const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
  if (finishReason === 'error') {
    throw new OpenRouterError({ kind: 'provider', message: 'Provider ended the response with an error' });
  }
  const message = asRecord(choice.message);
  const result: ChatResult = {
    id: typeof root.id === 'string' ? root.id : undefined,
    model: typeof root.model === 'string' ? root.model : undefined,
    text: extractText(message?.content),
    finishReason,
    usage: normalizeUsage(root.usage),
  };
  if (typeof message?.refusal === 'string' && message.refusal) result.refusal = message.refusal;
  return result;
}

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------

export function createOpenRouterClient(options: OpenRouterClientOptions): OpenRouterClient {
  const apiKey = (options.apiKey ?? '').trim();
  const baseUrl = (options.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, '');
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? 2;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  const getFetch = (): FetchLike => {
    if (options.fetch) return options.fetch;
    const f = (globalThis as { fetch?: FetchLike }).fetch;
    if (!f) {
      throw new OpenRouterError({ kind: 'network', message: 'fetch is not available in this runtime' });
    }
    return f.bind(globalThis);
  };

  const buildHeaders = (auth: boolean, hasBody: boolean, stream: boolean): Record<string, string> => {
    const headers: Record<string, string> = {
      Accept: stream ? 'text/event-stream' : 'application/json',
    };
    if (hasBody) headers['Content-Type'] = 'application/json';
    if (auth) headers.Authorization = `Bearer ${apiKey}`;
    if (options.appUrl) headers['HTTP-Referer'] = options.appUrl;
    if (options.appTitle) headers['X-Title'] = options.appTitle;
    return headers;
  };

  const backoffMs = (attempt: number): number => {
    const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
    return Math.round(base * (0.5 + random() * 0.5));
  };

  interface SendOptions {
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
    auth: boolean;
    stream: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
  }

  /** Performs the HTTP call incl. retries for 408/429/5xx. Returns the OK response and its live link. */
  async function send(o: SendOptions): Promise<{ response: Response; link: Link }> {
    if (o.auth && !apiKey) {
      throw new OpenRouterError({
        kind: 'auth',
        message: 'No OpenRouter key configured',
        userMessage: 'No OpenRouter key is set. Connect OpenRouter in Settings first.',
      });
    }
    const url = `${baseUrl}${o.path}`;
    const timeoutMs = o.timeoutMs ?? defaultTimeout;
    const bodyText = o.body === undefined ? undefined : JSON.stringify(o.body);

    for (let attempt = 0; ; attempt++) {
      if (o.signal?.aborted) throw new AbortError();
      const link = createLink(o.signal, timeoutMs);
      let response: Response;
      try {
        response = await getFetch()(url, {
          method: o.method,
          headers: buildHeaders(o.auth, bodyText !== undefined, o.stream),
          body: bodyText,
          signal: link.signal,
        });
      } catch (e) {
        const err = classifyThrown(e, link, o.signal, apiKey);
        link.cleanup();
        throw err;
      }

      if (response.ok) return { response, link };

      let errText = '';
      try {
        errText = await response.text();
      } catch {
        errText = '';
      }
      link.cleanup();
      const retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'));
      const err = errorFromResponse({
        status: response.status,
        body: tryParseJson(errText) ?? errText,
        retryAfterMs,
        apiKey,
      });

      const waitMs = retryAfterMs ?? backoffMs(attempt);
      if (isRetryableStatus(response.status) && attempt < maxRetries && waitMs <= MAX_RETRY_AFTER_MS) {
        await sleep(waitMs, o.signal);
        if (o.signal?.aborted) throw new AbortError();
        continue;
      }
      throw err;
    }
  }

  async function requestJson(o: Omit<SendOptions, 'stream'>): Promise<unknown> {
    const { response, link } = await send({ ...o, stream: false });
    let text: string;
    try {
      text = await response.text();
    } catch (e) {
      throw classifyThrown(e, link, o.signal, apiKey);
    } finally {
      link.cleanup();
    }
    const parsed = tryParseJson(text);
    if (parsed === undefined) {
      throw new OpenRouterError({
        kind: 'provider',
        message: `OpenRouter returned a non-JSON response (HTTP ${response.status})`,
      });
    }
    return parsed;
  }

  function buildChatBody(req: ChatRequest, stream: boolean): Json {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const id of [req.model, ...(req.models ?? [])]) {
      if (id && !seen.has(id)) {
        seen.add(id);
        list.push(id);
      }
    }
    if (list.length === 0) {
      throw new OpenRouterError({ kind: 'bad_request', message: 'No model specified' });
    }
    const body: Json = { messages: req.messages };
    if (list.length > 1) body.models = list;
    else body.model = list[0];
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.topP !== undefined) body.top_p = req.topP;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.responseFormat) body.response_format = req.responseFormat;
    if (req.requireParameters || req.provider) {
      body.provider = {
        ...(req.provider ?? {}),
        ...(req.requireParameters ? { require_parameters: true } : {}),
      };
    }
    if (stream) body.stream = true;
    return body;
  }

  async function chat(req: ChatRequest): Promise<ChatResult> {
    const json = await requestJson({
      method: 'POST',
      path: '/chat/completions',
      body: buildChatBody(req, false),
      auth: true,
      signal: req.signal,
      timeoutMs: req.timeoutMs,
    });
    return parseChatResponse(json, apiKey);
  }

  async function* chatStream(req: ChatStreamRequest): AsyncGenerator<ChatStreamEvent, void, undefined> {
    if (req.stream === false) {
      const result = await chat(req);
      if (result.text) yield { type: 'delta', text: result.text };
      yield { type: 'done', usage: result.usage, finishReason: result.finishReason, model: result.model, id: result.id };
      return;
    }

    const { response, link } = await send({
      method: 'POST',
      path: '/chat/completions',
      body: buildChatBody(req, true),
      auth: true,
      stream: true,
      signal: req.signal,
      timeoutMs: req.timeoutMs,
    });
    const idleMs = req.timeoutMs ?? defaultTimeout;

    let usage: ChatUsage | undefined;
    let finishReason: string | null | undefined;
    let model: string | undefined;
    let id: string | undefined;
    let sawData = false;
    let finished = false;
    let completed = false;

    // Returns the delta text for an event ('' if none); throws on stream errors.
    const handleEvent = (ev: SseEvent): string => {
      const data = ev.data.trim();
      if (data === '' ) return '';
      if (data === '[DONE]') {
        finished = true;
        return '';
      }
      const chunk = tryParseJson(data);
      const c = asRecord(chunk);
      if (!c) return '';
      sawData = true;
      if (c.error) throw errorFromBodyError({ error: c.error }, apiKey);
      if (typeof c.id === 'string') id = c.id;
      if (typeof c.model === 'string') model = c.model;
      if (c.usage) usage = normalizeUsage(c.usage) ?? usage;
      const choice = asRecord(Array.isArray(c.choices) ? c.choices[0] : undefined);
      if (!choice) return '';
      if (choice.error) throw errorFromBodyError({ error: choice.error }, apiKey);
      if (typeof choice.finish_reason === 'string') {
        if (choice.finish_reason === 'error') {
          throw new OpenRouterError({ kind: 'provider', message: 'Provider ended the stream with an error' });
        }
        finishReason = choice.finish_reason;
      }
      const delta = asRecord(choice.delta);
      const content = delta?.content;
      return typeof content === 'string' ? content : '';
    };

    try {
      const parser = createSseParser();
      const decoder = new TextDecoder();
      const body = response.body as ReadableStream<Uint8Array | string> | null | undefined;

      if (body && typeof body.getReader === 'function') {
        const reader = body.getReader();
        try {
          while (!finished) {
            link.arm(idleMs);
            let chunk: ReadableStreamReadResult<Uint8Array | string>;
            try {
              chunk = await reader.read();
            } catch (e) {
              throw classifyThrown(e, link, req.signal, apiKey);
            }
            if (chunk.done) break;
            const text =
              typeof chunk.value === 'string' ? chunk.value : decoder.decode(chunk.value, { stream: true });
            for (const ev of parser.feed(text)) {
              const delta = handleEvent(ev);
              if (delta) yield { type: 'delta', text: delta };
              if (finished) break;
            }
          }
          if (!finished) {
            for (const ev of parser.flush()) {
              const delta = handleEvent(ev);
              if (delta) yield { type: 'delta', text: delta };
            }
          }
        } finally {
          // Not awaited: some stream implementations only settle cancel() once every tee branch is cancelled.
          reader.cancel().catch(() => undefined);
        }
      } else {
        // Non-streaming fallback (e.g. React Native's built-in fetch has no body stream):
        // read the full SSE payload and replay it.
        let all: string;
        try {
          all = await response.text();
        } catch (e) {
          throw classifyThrown(e, link, req.signal, apiKey);
        }
        const events = [...parser.feed(all), ...parser.flush()];
        for (const ev of events) {
          const delta = handleEvent(ev);
          if (delta) yield { type: 'delta', text: delta };
          if (finished) break;
        }
      }

      if (!sawData && !finished) {
        throw new OpenRouterError({ kind: 'provider', message: 'The stream ended without any data' });
      }
      completed = true;
      yield { type: 'done', usage, finishReason, model, id };
    } finally {
      link.cleanup();
      if (!completed) link.abort(); // consumer stopped early or an error occurred: free the connection
    }
  }

  async function getKeyInfo(opts?: { signal?: AbortSignal }): Promise<KeyInfo> {
    const json = await requestJson({ method: 'GET', path: '/key', auth: true, signal: opts?.signal });
    return normalizeKeyInfo(json);
  }

  async function listModels(opts: ListModelsOptions = {}): Promise<ModelInfo[]> {
    const query = buildQuery([
      ['input_modalities', opts.imageInput ? 'text,image' : undefined],
      ['supported_parameters', opts.structuredOutputs ? 'structured_outputs' : undefined],
      ['sort', opts.sort],
      ['q', opts.q],
      ['limit', opts.limit],
      ['max_price', opts.maxPromptPricePerM],
    ]);
    // /models is public: do not send the key.
    const json = await requestJson({
      method: 'GET',
      path: `/models${query}`,
      auth: false,
      signal: opts.signal,
    });
    const data = asRecord(json)?.data;
    if (!Array.isArray(data)) {
      throw new OpenRouterError({ kind: 'provider', message: 'Unexpected /models response shape' });
    }
    let models = data.map(normalizeModel).filter((m): m is ModelInfo => m !== null);
    // Server-side filters are best effort (the comma semantics of input_modalities are not documented): re-check here.
    if (opts.imageInput) models = models.filter((m) => m.supportsImages);
    if (opts.structuredOutputs) models = models.filter((m) => m.supportsStructuredOutputs);
    return models;
  }

  type Validation<T> = { ok: true; data: T } | { ok: false; error: string };

  function validateReply<T>(text: string, schema: z.ZodType<T>): Validation<T> {
    let raw: unknown;
    try {
      raw = parseJsonLoose(text);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'parse error';
      return { ok: false, error: `The reply was not valid JSON (${msg.slice(0, 120)}).` };
    }
    const first = schema.safeParse(raw);
    if (first.success) return { ok: true, data: first.data };
    // Strict-mode schemas make optional fields nullable; accept null as "absent".
    const second = schema.safeParse(stripNulls(raw));
    if (second.success) return { ok: true, data: second.data };
    return { ok: false, error: summarizeIssues(first.error) };
  }

  async function chatJson<T>(req: ChatJsonRequest<T>): Promise<T> {
    const jsonSchema = toStrictJsonSchema(req.schema, { nullableOptionals: req.optionalFields !== 'omit' });
    const messages = attachImagesToLastUserMessage(req.messages, req.images);
    const base: Omit<ChatRequest, 'messages'> = {
      model: req.model,
      models: req.models,
      temperature: req.temperature ?? 0.2,
      maxTokens: req.maxTokens,
      responseFormat: {
        type: 'json_schema',
        json_schema: { name: sanitizeSchemaName(req.jsonSchemaName), strict: true, schema: jsonSchema },
      },
      requireParameters: true,
      signal: req.signal,
      timeoutMs: req.timeoutMs,
    };

    const first = await chat({ ...base, messages });
    if (first.refusal && !first.text.trim()) {
      throw new OpenRouterError({
        kind: 'moderation',
        message: `Model refused: ${first.refusal.slice(0, 200)}`,
        userMessage: 'The AI model declined to process this request. Try different input or another model.',
      });
    }
    const v1 = validateReply(first.text, req.schema);
    if (v1.ok) return v1.data;

    const repairMessages: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: first.text.slice(0, 4000) || '(empty reply)' },
      {
        role: 'user',
        content:
          `Your previous reply was rejected: ${v1.error}\n` +
          'Reply again with ONLY a single JSON value that matches the required schema exactly. ' +
          'No markdown fences, no commentary.',
      },
    ];
    const second = await chat({ ...base, messages: repairMessages });
    const v2 = validateReply(second.text, req.schema);
    if (v2.ok) return v2.data;

    throw new OpenRouterError({
      kind: 'invalid_output',
      message: `Model output failed validation after one repair attempt: ${v2.error}`,
      details: { finishReason: second.finishReason ?? null },
    });
  }

  return { getKeyInfo, listModels, chat, chatStream, chatJson };
}

/** Collects a full stream into text (useful when the caller does not need incremental output). */
export async function collectStream(
  stream: AsyncGenerator<ChatStreamEvent, void, undefined>,
  onDelta?: (text: string) => void,
): Promise<{ text: string; usage?: ChatUsage; finishReason?: string | null }> {
  let text = '';
  let usage: ChatUsage | undefined;
  let finishReason: string | null | undefined;
  for await (const ev of stream) {
    if (ev.type === 'delta') {
      text += ev.text;
      onDelta?.(ev.text);
    } else {
      usage = ev.usage;
      finishReason = ev.finishReason;
    }
  }
  return { text, usage, finishReason };
}
