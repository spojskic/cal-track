/**
 * Reads what an Edge Function answered from the error supabase-js returns for a non-2xx status.
 *
 * `functions.invoke()` resolves with `{ data: null, error }`: a `FunctionsHttpError` (the answer arrived, `context` is
 * the Response) or a `FunctionsFetchError` / `FunctionsRelayError` (no usable answer). Pure: no React Native imports.
 *
 * (data/foods.ts has its own private copy of this idea for the barcode and search functions; it is intentionally left
 * alone. New callers should use this module.)
 */
export interface FunctionFailure {
  /** HTTP status; null = the request never got an answer (network, relay). */
  status: number | null;
  /** The JSON body of the answer, when it was a JSON object. */
  body: Record<string, unknown> | null;
  /** Seconds from the `Retry-After` header. */
  retryAfter: number | null;
}

export function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function readFunctionFailure(error: unknown): Promise<FunctionFailure> {
  const e = error as { name?: string; context?: unknown } | null;
  const ctx = e?.context as Response | undefined;
  if (e?.name === 'FunctionsHttpError' && ctx && typeof ctx.status === 'number') {
    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = await ctx.json();
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      body = null;
    }
    return { status: ctx.status, body, retryAfter: toFiniteNumber(ctx.headers?.get?.('retry-after')) };
  }
  return { status: null, body: null, retryAfter: null };
}
