// The slice of `fetch` this package needs. Injected everywhere (no global fetch, no global state), so tests never touch
// the network and the app can pass React Native's fetch.

/** The slice of `Response` the client needs. The global `Response` satisfies it. */
export interface ResponseLike {
  status: number;
  headers?: { get(name: string): string | null } | null;
  text(): Promise<string>;
}

export interface FetchInit {
  /**
   * GET for every data request. POST exists for exactly one URL: the DI token endpoint (refresh and the first ticket
   * exchange). The data client never sends anything else, and a guard in it refuses to.
   */
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** `fetch` (or a fake). */
export type FetchLike = (url: string, init: FetchInit) => Promise<ResponseLike>;

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue>;

export type SleepFn = (ms: number) => Promise<void>;

export const realSleep: SleepFn = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `fetch` with an abort timeout. Rejects with an Error named 'AbortError' when the time is up. */
export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: Omit<FetchInit, 'signal'>,
  timeoutMs: number,
): Promise<{ response: ResponseLike; text: string }> {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      const error = new Error('timeout');
      error.name = 'AbortError';
      reject(error);
    }, timeoutMs);
  });
  try {
    const work = (async () => {
      const response = await fetchImpl(url, controller ? { ...init, signal: controller.signal } : { ...init });
      const text = await response.text();
      return { response, text };
    })();
    // If the timeout wins, the late result of `work` must not become an unhandled rejection.
    work.catch(() => undefined);
    return await Promise.race([work, timedOut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Seconds from a `Retry-After` header (delta-seconds form only), or undefined. */
export function retryAfterSeconds(response: ResponseLike): number | undefined {
  const raw = response.headers?.get('retry-after') ?? response.headers?.get('Retry-After') ?? null;
  if (raw === null) return undefined;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
