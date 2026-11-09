import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

/** Longest side sent to the model. ~1024 px keeps the request at roughly 150-400 KB and costs far less. */
export const MAX_IMAGE_SIDE = 1024;
export const JPEG_QUALITY = 0.75;

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
  const decoded = ImageManipulator.manipulate(uri, { maxWidth: MAX_IMAGE_SIDE, maxHeight: MAX_IMAGE_SIDE });
  let resizer: ReturnType<typeof ImageManipulator.manipulate> | null = null;
  try {
    const first = await decoded.renderAsync();
    let finalRef = first;
    if (Math.max(first.width, first.height) > MAX_IMAGE_SIDE) {
      // The decode hint is best effort (e.g. on web): enforce the limit explicitly.
      resizer = ImageManipulator.manipulate(first).resize(
        first.width >= first.height ? { width: MAX_IMAGE_SIDE, height: null } : { width: null, height: MAX_IMAGE_SIDE },
      );
      finalRef = await resizer.renderAsync();
    }
    const saved = await finalRef.saveAsync({ format: SaveFormat.JPEG, compress: JPEG_QUALITY, base64: true });
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
