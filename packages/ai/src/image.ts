/**
 * Image helpers (pure; no platform APIs).
 *
 * NOTE: Resizing / compression is NOT done here. The app resizes the photo to
 * about 1024 px on the long edge and re-encodes it as JPEG at quality ~0.75
 * (expo-image-manipulator on native, canvas on web) BEFORE calling these
 * helpers. That keeps the request small (~150-400 KB), cheap and fast.
 */

import { OpenRouterError } from './errors';
import type { ImageInput, ImagePart } from './types';

/** Practical upper bound for the base64 payload we are willing to send. */
export const MAX_IMAGE_BASE64_CHARS = 4 * 1024 * 1024;

const ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);

const DATA_URL_PREFIX = /^data:[^;,]+;base64,/i;

/** Strips an accidental `data:...;base64,` prefix and all whitespace. */
export function normalizeBase64(base64: string): string {
  return base64.replace(DATA_URL_PREFIX, '').replace(/\s+/g, '');
}

/** Approximate decoded size in bytes of a base64 string. */
export function estimateDecodedBytes(base64: string): number {
  const clean = normalizeBase64(base64);
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

export function assertReasonableImageSize(base64: string, maxBase64Chars = MAX_IMAGE_BASE64_CHARS): void {
  const clean = normalizeBase64(base64);
  if (clean.length === 0) {
    throw new OpenRouterError({
      kind: 'bad_request',
      message: 'Image is empty',
      userMessage: 'The photo could not be read. Please take or choose another one.',
    });
  }
  if (clean.length > maxBase64Chars) {
    throw new OpenRouterError({
      kind: 'bad_request',
      message: `Image too large: ${clean.length} base64 chars (max ${maxBase64Chars})`,
      userMessage: 'This photo is too large to analyse. Try a smaller photo (the app normally resizes it for you).',
    });
  }
}

function normalizeMime(mime: string): string {
  const m = mime.trim().toLowerCase();
  return m === 'image/jpg' ? 'image/jpeg' : m;
}

export function toDataUrl(base64: string, mimeType: string): string {
  const mime = normalizeMime(mimeType);
  if (!ALLOWED_MIME.has(mime)) {
    throw new OpenRouterError({
      kind: 'bad_request',
      message: `Unsupported image type: ${mimeType}`,
      userMessage: 'Unsupported image format. Use a JPEG, PNG or WebP photo.',
    });
  }
  return `data:${mime};base64,${normalizeBase64(base64)}`;
}

/** Builds the OpenAI-compatible `image_url` content part for a base64 image. */
export function toImagePart(base64: string, mime: string): ImagePart {
  assertReasonableImageSize(base64);
  return { type: 'image_url', image_url: { url: toDataUrl(base64, mime) } };
}

export function imageInputToPart(image: ImageInput): ImagePart {
  return toImagePart(image.base64, image.mimeType);
}
