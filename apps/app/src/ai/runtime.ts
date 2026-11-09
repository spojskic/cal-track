/**
 * Runtime guards for @cal/ai on React Native (Hermes).
 *
 * @cal/ai needs `TextEncoder` (PKCE challenge) and `TextDecoder` (streaming SSE replies). expo/fetch itself
 * already relies on a global `TextDecoder`, so current Hermes builds are expected to provide both. These tiny
 * UTF-8 shims are installed ONLY when a global is missing; where it exists nothing is touched.
 *
 * `crypto.getRandomValues` is deliberately NOT polyfilled globally: the PKCE code receives expo-crypto's
 * CSPRNG by injection (see oauth.ts), and SHA-256 falls back to @cal/ai's pure-JS implementation.
 */

function encodeUtf8(input: string): Uint8Array {
  const out: number[] = [];
  for (const ch of input) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return Uint8Array.from(out);
}

class Utf8Encoder {
  readonly encoding = 'utf-8';
  encode(input = ''): Uint8Array {
    return encodeUtf8(String(input));
  }
}

class Utf8Decoder {
  readonly encoding = 'utf-8';
  readonly fatal = false;
  readonly ignoreBOM = false;
  private pending: number[] = [];

  decode(input?: ArrayBuffer | ArrayBufferView, options?: { stream?: boolean }): string {
    let bytes: Uint8Array;
    if (!input) bytes = new Uint8Array(0);
    else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    else bytes = new Uint8Array(input);
    const all = this.pending.length > 0 ? Uint8Array.from([...this.pending, ...bytes]) : bytes;
    this.pending = [];

    let out = '';
    let i = 0;
    while (i < all.length) {
      const b = all[i] as number;
      if (b < 0x80) {
        out += String.fromCharCode(b);
        i += 1;
        continue;
      }
      let need = 0;
      let cp = 0;
      if (b >= 0xc2 && b <= 0xdf) {
        need = 1;
        cp = b & 0x1f;
      } else if (b >= 0xe0 && b <= 0xef) {
        need = 2;
        cp = b & 0x0f;
      } else if (b >= 0xf0 && b <= 0xf4) {
        need = 3;
        cp = b & 0x07;
      } else {
        out += '\ufffd';
        i += 1;
        continue;
      }
      if (i + need > all.length - 1) {
        // Truncated sequence at the end of the chunk.
        if (options?.stream) {
          this.pending = Array.from(all.subarray(i));
        } else {
          out += '\ufffd';
        }
        break;
      }
      let valid = true;
      for (let k = 1; k <= need; k++) {
        const c = all[i + k] as number;
        if ((c & 0xc0) !== 0x80) {
          valid = false;
          break;
        }
        cp = (cp << 6) | (c & 0x3f);
      }
      if (!valid) {
        out += '\ufffd';
        i += 1;
        continue;
      }
      out += cp > 0x10ffff ? '\ufffd' : String.fromCodePoint(cp);
      i += need + 1;
    }
    return out;
  }
}

let installed = false;

/** Idempotent. Safe to call from anywhere before using @cal/ai. */
export function ensureAiRuntime(): void {
  if (installed) return;
  installed = true;
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.TextEncoder === 'undefined') g.TextEncoder = Utf8Encoder;
  if (typeof g.TextDecoder === 'undefined') g.TextDecoder = Utf8Decoder;
}
