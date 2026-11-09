/**
 * Serves the exported web build from disk for the fake origin (no sockets involved): exact files first, then the
 * single-page-app fallback to index.html for paths that are not files (expo-router `web.output: "single"`).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export interface ServedFile {
  status: number;
  body: Buffer;
  contentType: string;
  /** True when index.html was served for a client-side route. */
  fallback: boolean;
  file: string;
}

export class AppFiles {
  private readonly root: string;
  private readonly cache = new Map<string, Buffer>();

  constructor(distDir: string) {
    this.root = resolve(distDir);
  }

  get indexExists(): boolean {
    return existsSync(join(this.root, 'index.html'));
  }

  private read(file: string): Buffer {
    let buf = this.cache.get(file);
    if (!buf) {
      buf = readFileSync(file);
      this.cache.set(file, buf);
    }
    return buf;
  }

  /** Absolute path inside the dist dir, or null (traversal / NUL bytes / malformed escapes). */
  private resolveInside(pathname: string): string | null {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (decoded.includes('\0')) return null;
    const full = resolve(this.root, `.${normalize(`/${decoded}`)}`);
    return full === this.root || full.startsWith(this.root + sep) ? full : null;
  }

  /**
   * @param pathname URL pathname, e.g. `/_expo/static/js/web/entry-abc.js` or `/food/123`
   * @param accept request Accept header (navigations ask for text/html)
   * @returns the file / fallback, or null when the answer is 404
   */
  serve(pathname: string, accept = ''): ServedFile | null {
    const full = this.resolveInside(pathname);
    if (full === null) return null;
    const candidates = pathname.endsWith('/') || full === this.root ? [join(full, 'index.html')] : [full, `${full}.html`];
    for (const file of candidates) {
      if (existsSync(file) && statSync(file).isFile()) {
        return { status: 200, body: this.read(file), contentType: contentTypeFor(file), fallback: false, file };
      }
    }
    const last = pathname.split('/').filter(Boolean).pop() ?? '';
    const looksLikeFile = /\.[A-Za-z0-9]{1,8}$/.test(last);
    const wantsHtml = accept.includes('text/html');
    if (!looksLikeFile || wantsHtml) {
      const index = join(this.root, 'index.html');
      if (existsSync(index)) return { status: 200, body: this.read(index), contentType: CONTENT_TYPES['.html'] as string, fallback: true, file: index };
    }
    return null;
  }
}
