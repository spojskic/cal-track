// Web: Garmin cannot be read from a browser (CORS), so there is nothing to store. Same API as garmin-tokens.ts.
import type { GarminTokens } from '@ration/garmin';

export async function loadGarminTokens(_userId: string): Promise<GarminTokens | null> {
  return null;
}

export async function hasGarminTokens(_userId: string): Promise<boolean> {
  return false;
}

export async function saveGarminTokens(_userId: string, _tokens: GarminTokens): Promise<void> {
  throw new Error('Garmin sync runs in the iPhone and Android app.');
}

export async function clearGarminTokens(): Promise<void> {}
