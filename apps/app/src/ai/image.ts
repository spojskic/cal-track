import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

/** Longest side sent to the model. ~1024 px keeps the request at roughly 150-400 KB and costs far less. */
export const MAX_IMAGE_SIDE = 1024;
export const JPEG_QUALITY = 0.75;

/** Nutrition labels are small print: a larger photo (~300-700 KB) keeps the digits readable. */
export const MAX_LABEL_IMAGE_SIDE = 1600;
export const LABEL_JPEG_QUALITY = 0.8;

export interface PreparedImage {
  /** Raw base64 (no data: prefix). Held in memory only; never persisted or uploaded to our backend. */
  base64: string;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
}

/**
 * Resizes a picked photo on the device (longest side 1024 px) and re-encodes it as JPEG (quality 0.75).
 * The decode step down-samples large camera photos so the full-size bitmap is never held in memory.
 * Works on native and on web (canvas under the hood).
 */
export async function prepareMealImage(uri: string): Promise<PreparedImage> {
  return prepareImage(uri, MAX_IMAGE_SIDE, JPEG_QUALITY);
}

/** Same as {@link prepareMealImage} with a larger limit (1600 px, quality 0.8) for the small print of a nutrition label. */
export async function prepareLabelImage(uri: string): Promise<PreparedImage> {
  return prepareImage(uri, MAX_LABEL_IMAGE_SIDE, LABEL_JPEG_QUALITY);
}

async function prepareImage(uri: string, maxSide: number, quality: number): Promise<PreparedImage> {
  const decoded = ImageManipulator.manipulate(uri, { maxWidth: maxSide, maxHeight: maxSide });
  let resizer: ReturnType<typeof ImageManipulator.manipulate> | null = null;
  try {
    const first = await decoded.renderAsync();
    let finalRef = first;
    if (Math.max(first.width, first.height) > maxSide) {
      // The decode hint is best effort (e.g. on web): enforce the limit explicitly.
      resizer = ImageManipulator.manipulate(first).resize(
        first.width >= first.height ? { width: maxSide, height: null } : { width: null, height: maxSide },
      );
      finalRef = await resizer.renderAsync();
    }
    const saved = await finalRef.saveAsync({ format: SaveFormat.JPEG, compress: quality, base64: true });
    if (!saved.base64) throw new Error('empty');
    return { base64: saved.base64, mimeType: 'image/jpeg', width: saved.width, height: saved.height };
  } catch {
    throw new Error('This photo could not be read or resized. Try a JPEG or PNG photo, or take a new one.');
  } finally {
    try {
      resizer?.release();
      decoded.release();
    } catch {
      // releasing is best effort
    }
  }
}
