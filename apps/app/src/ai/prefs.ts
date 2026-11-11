import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ModelInfo } from '@cal/ai';

import { migrateAsyncKey } from '@/lib/migrate-key';

/**
 * Non-secret AI preferences and the model catalogue cache. The API key is NEVER stored here
 * (it lives in `keyStore`: Keychain/Keystore on native, encrypted IndexedDB on web).
 */
const PREFS_KEY = 'ration.ai.prefs.v1';
const MODELS_KEY = 'ration.ai.models.v1';
/** Keys from before the app was renamed, moved on first read. */
const LEGACY_PREFS_KEY = 'cal-track.ai.prefs.v1';
const LEGACY_MODELS_KEY = 'cal-track.ai.models.v1';

export interface AiPrefs {
  selectedModelId: string | null;
  /** Web only: persist the key on this device (true) or keep it in memory for this session (false). */
  rememberOnDevice: boolean;
}

export const DEFAULT_PREFS: AiPrefs = { selectedModelId: null, rememberOnDevice: true };

export async function loadPrefs(): Promise<AiPrefs> {
  try {
    await migrateAsyncKey(LEGACY_PREFS_KEY, PREFS_KEY);
    const raw = await AsyncStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<AiPrefs>;
    return {
      selectedModelId: typeof parsed.selectedModelId === 'string' ? parsed.selectedModelId : null,
      rememberOnDevice: parsed.rememberOnDevice !== false,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export async function savePrefs(prefs: AiPrefs): Promise<void> {
  try {
    await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // preferences are best effort
  }
}

export interface ModelsCache {
  at: number;
  models: ModelInfo[];
}

export async function loadModelsCache(): Promise<ModelsCache | null> {
  try {
    await migrateAsyncKey(LEGACY_MODELS_KEY, MODELS_KEY);
    const raw = await AsyncStorage.getItem(MODELS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ModelsCache>;
    if (!parsed || typeof parsed.at !== 'number' || !Array.isArray(parsed.models)) return null;
    const models = parsed.models.filter(
      (m): m is ModelInfo => typeof m === 'object' && m !== null && typeof (m as ModelInfo).id === 'string',
    );
    return { at: parsed.at, models };
  } catch {
    return null;
  }
}

export async function saveModelsCache(cache: ModelsCache): Promise<void> {
  try {
    await AsyncStorage.setItem(MODELS_KEY, JSON.stringify(cache));
  } catch {
    // the cache is best effort
  }
}
