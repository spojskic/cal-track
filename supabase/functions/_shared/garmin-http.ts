/**
 * Request/response helpers for the Garmin functions that cannot use handleHttp() from http.ts: the webhook needs a much
 * larger body limit than 10 000 characters (and possibly gzip), and the OAuth callback is a GET that answers a redirect.
 * Pure: web-standard Request / Response / streams only.
 */

export type BodyRead = { ok: true; text: string } | { ok: false; status: 400 | 413; error: string };

// UNVERIFIED: size and compression of Garmin pushes (gzip is handled if sent; plain JSON is assumed).
/** Garmin pushes can carry large sample maps; 5 MB is far above anything a single user's push contains. */
export const MAX_WEBHOOK_BYTES = 5 * 1024 * 1024;

/**
 * Reads a request body as text with a hard byte cap (counted after decompression). `Content-Encoding: gzip` is
 * transparently inflated. UNVERIFIED: whether Garmin compresses its pushes; plain bodies are the normal case.
 */
export async function readRequestText(
  req: Request,
  maxBytes = MAX_WEBHOOK_BYTES,
): Promise<BodyRead> {
  const declared = Number(req.headers.get('content-length'));
  if (
    Number.isFinite(declared) &&
    declared > maxBytes &&
    !/gzip/i.test(req.headers.get('content-encoding') ?? '')
  ) {
    return { ok: false, status: 413, error: 'payload_too_large' };
  }
  if (!req.body) return { ok: true, text: '' };

  let stream: ReadableStream<Uint8Array> = req.body;
  if (/gzip/i.test(req.headers.get('content-encoding') ?? '')) {
    if (typeof DecompressionStream === 'undefined')
      return { ok: false, status: 400, error: 'unsupported_encoding' };
    stream = stream.pipeThrough(
      new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>,
    );
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, status: 413, error: 'payload_too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, error: 'unreadable_body' };
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(all) };
}

/** 302 to `location`. (Supabase serves HTML from functions as text/plain, so a redirect is the only way to hand back to the app.) */
export function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}

/** Plain-text answer for browser-facing endpoints (callback errors that have no app to return to). */
export function textResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
