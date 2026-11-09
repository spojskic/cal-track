import {
  exchangeAuthCode,
  keyStatusFromValidation,
  parsePastedCode,
  presentAiError,
  validateKey,
  type KeyInfo,
  type KeyStatus,
  type ModelInfo,
  type ValidateKeyResult,
} from '@cal/ai';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import { create } from 'zustand';

import { createAiClient, getAiFetch } from './create-client';
import { keyStore } from './key-store';
import { findSelectedModel, resolveModelSelection } from './model-selection';
import { beginOAuth, clearPending, consumeWebReturn, hasPendingFlow, pendingVerifier } from './oauth';
import {
  loadModelsCache,
  loadPrefs,
  saveModelsCache,
  savePrefs,
  type AiPrefs,
} from './prefs';

/** The model catalogue is re-downloaded when older than this (the picker has a manual refresh too). */
const MODELS_TTL_MS = 12 * 60 * 60 * 1000;

export interface ActionResult {
  ok: boolean;
  /** Safe-to-show message (never contains the key). */
  message?: string;
}

export interface AiState {
  /** The key in memory. NEVER log it, put it in a query key, an error or a URL. */
  apiKey: string | null;
  keyStatus: KeyStatus;
  keyInfo: KeyInfo | null;
  /** Why the status is 'unknown' / 'invalid' (network failure text, rejection text). */
  validationError: string | null;
  /** Image-capable models. */
  models: ModelInfo[];
  modelsFetchedAt: number | null;
  modelsBusy: boolean;
  modelsError: string | null;
  selectedModelId: string | null;
  /** Set when the saved model had to be replaced. */
  modelNotice: string | null;
  rememberOnDevice: boolean;
  /** Native headless OAuth: the browser was opened and the user must paste the code. */
  oauthAwaitingCode: boolean;
  /** init() finished at least once (the gate says 'checking' until then). */
  loaded: boolean;
  /** A connect / disconnect / OAuth action is running. */
  busy: boolean;
  /** GET /key is running. */
  validating: boolean;
  /** Last action error, safe to show. */
  error: string | null;

  init: () => Promise<void>;
  connectWithKey: (key: string, options?: { persist?: boolean }) => Promise<ActionResult>;
  startOAuth: () => Promise<ActionResult & { mode?: 'redirect' | 'paste' }>;
  finishOAuth: (input: { kind: 'url'; url: string } | { kind: 'pasted'; text: string }) => Promise<
    ActionResult & { ignored?: boolean }
  >;
  cancelOAuth: () => void;
  disconnect: () => Promise<ActionResult>;
  selectModel: (id: string) => void;
  refreshModels: (options?: { force?: boolean }) => Promise<void>;
  revalidate: () => Promise<void>;
  setRememberOnDevice: (value: boolean) => Promise<void>;
  clearError: () => void;
}

/** Network/validation outcome check that never throws (aborts are the only thing validateKey rethrows). */
async function checkKey(key: string): Promise<ValidateKeyResult> {
  try {
    return await validateKey(createAiClient(key));
  } catch {
    return { status: 'error', error: 'Could not check your OpenRouter key. Try again later.' };
  }
}

export const useAiStore = create<AiState>()((set, get) => {
  let initPromise: Promise<void> | null = null;
  let validationRun = 0;
  let modelsRun = 0;

  const prefsSnapshot = (): AiPrefs => ({
    selectedModelId: get().selectedModelId,
    rememberOnDevice: get().rememberOnDevice,
  });

  /** Keeps the saved model if it is still offered, otherwise switches to the recommended default. */
  const applySelection = (): void => {
    const { models, selectedModelId } = get();
    const result = resolveModelSelection(models, selectedModelId);
    if (!result.model) return;
    if (result.model.id !== selectedModelId) {
      set({
        selectedModelId: result.model.id,
        modelNotice: result.changedFrom
          ? `Your previous model (${result.changedFrom}) is no longer available or no longer accepts images. Switched to ${result.model.name}.`
          : null,
      });
      void savePrefs(prefsSnapshot());
    }
  };

  const applyValidation = (key: string, result: ValidateKeyResult): void => {
    if (get().apiKey !== key) return;
    set({
      keyStatus: keyStatusFromValidation(result),
      keyInfo: result.status === 'valid' ? result.info : result.status === 'invalid' ? null : get().keyInfo,
      validationError: result.status === 'valid' ? null : result.error,
    });
  };

  const fail = (message: string): ActionResult => {
    set({ error: message, busy: false });
    return { ok: false, message };
  };

  const exchangeAndConnect = async (code: string, verifier: string, persist: boolean): Promise<ActionResult> => {
    let key: string;
    try {
      key = await exchangeAuthCode({ code, verifier, fetch: getAiFetch() });
    } catch (e) {
      const p = presentAiError(e, [code, verifier]);
      // A rejected code can never work again: forget the flow. Network errors keep it so the user can retry.
      if (p.kind !== 'network' && p.kind !== 'timeout') clearPending();
      set({ oauthAwaitingCode: hasPendingFlow() });
      return fail(p.message);
    }
    clearPending();
    set({ oauthAwaitingCode: false });
    // connectWithKey validates (GET /key) before anything is stored.
    return get().connectWithKey(key, { persist });
  };

  return {
    apiKey: null,
    keyStatus: 'unknown',
    keyInfo: null,
    validationError: null,
    models: [],
    modelsFetchedAt: null,
    modelsBusy: false,
    modelsError: null,
    selectedModelId: null,
    modelNotice: null,
    rememberOnDevice: true,
    oauthAwaitingCode: false,
    loaded: false,
    busy: false,
    validating: false,
    error: null,

    init: () => {
      if (initPromise) return initPromise;
      initPromise = (async () => {
        try {
          const [prefs, cache] = await Promise.all([loadPrefs(), loadModelsCache()]);
          set({
            selectedModelId: prefs.selectedModelId,
            rememberOnDevice: prefs.rememberOnDevice,
            models: cache?.models ?? [],
            modelsFetchedAt: cache?.at ?? null,
            oauthAwaitingCode: hasPendingFlow() && Platform.OS !== 'web',
          });

          let key: string | null = null;
          try {
            key = await keyStore.load();
          } catch {
            key = null;
          }
          if (!key) return;
          set({ apiKey: key, keyStatus: 'unknown', validating: true });
          await get().revalidate();
        } catch {
          // init must never reject: the gate simply stays closed
        } finally {
          set({ loaded: true, validating: false });
        }
      })();
      return initPromise;
    },

    revalidate: async () => {
      const key = get().apiKey;
      if (!key) return;
      const run = ++validationRun;
      set({ validating: true });
      const result = await checkKey(key);
      if (run !== validationRun || get().apiKey !== key) return;
      applyValidation(key, result);
      set({ validating: false });
      if (result.status === 'valid') await get().refreshModels();
    },

    connectWithKey: async (rawKey, options) => {
      const key = rawKey.trim();
      if (!key) return fail('Paste your OpenRouter API key first.');
      if (/\s/.test(key)) return fail('An API key has no spaces or line breaks. Check what you pasted.');
      set({ busy: true, error: null });

      // Validate FIRST; nothing is stored unless OpenRouter accepts the key.
      const result = await checkKey(key);
      if (result.status === 'invalid') {
        return fail('OpenRouter rejected this key. Check that you copied all of it, or create a new one.');
      }
      if (result.status === 'error') {
        return fail(`${result.error} Your key was not saved.`);
      }
      const persist = options?.persist ?? get().rememberOnDevice;
      try {
        await keyStore.save(key, { persist });
      } catch {
        return fail('Could not store the key on this device.');
      }
      validationRun++; // supersede any older GET /key still in flight
      set({
        apiKey: key,
        keyStatus: 'valid',
        keyInfo: result.info,
        validationError: null,
        validating: false,
        busy: false,
        error: null,
        oauthAwaitingCode: false,
        rememberOnDevice: persist,
      });
      void savePrefs(prefsSnapshot());
      await get().refreshModels();
      return { ok: true };
    },

    startOAuth: async () => {
      set({ busy: true, error: null });
      try {
        const begin = await beginOAuth(get().rememberOnDevice);
        if (begin.mode === 'redirect') {
          // Leaves the page; the settings screen finishes the flow when OpenRouter redirects back.
          window.location.assign(begin.url);
          return { ok: true, mode: 'redirect' };
        }
        set({ busy: false, oauthAwaitingCode: true });
        try {
          await WebBrowser.openBrowserAsync(begin.url);
        } catch {
          // The browser could not open; the user can still use "open again" or paste a key.
        }
        return { ok: true, mode: 'paste' };
      } catch (e) {
        return fail(presentAiError(e).message);
      }
    },

    finishOAuth: async (input) => {
      if (input.kind === 'url') {
        const returned = consumeWebReturn(input.url);
        if (returned.kind === 'none') return { ok: false, ignored: true };
        if (returned.kind === 'error') return fail(returned.message);
        set({ busy: true, error: null });
        return exchangeAndConnect(returned.code, returned.verifier, returned.persist);
      }

      const code = parsePastedCode(input.text);
      if (!code) return fail('Paste the code shown by OpenRouter (or the full address it redirected to).');
      const verifier = pendingVerifier();
      if (!verifier) {
        set({ oauthAwaitingCode: false });
        return fail('This sign-in is no longer active. Tap "Connect with OpenRouter" to start again.');
      }
      set({ busy: true, error: null });
      return exchangeAndConnect(code, verifier, true);
    },

    cancelOAuth: () => {
      clearPending();
      set({ oauthAwaitingCode: false, error: null });
    },

    disconnect: async () => {
      validationRun++;
      modelsRun++;
      set({ busy: true, error: null });
      let message: string | undefined;
      try {
        await keyStore.clear();
      } catch {
        message = 'The key could not be fully removed from this device. Try again.';
      }
      clearPending();
      set({
        apiKey: null,
        keyStatus: 'unknown',
        keyInfo: null,
        validationError: null,
        validating: false,
        modelsBusy: false,
        oauthAwaitingCode: false,
        busy: false,
        error: message ?? null,
      });
      return message ? { ok: false, message } : { ok: true };
    },

    selectModel: (id) => {
      if (!get().models.some((m) => m.id === id)) return;
      set({ selectedModelId: id, modelNotice: null });
      void savePrefs(prefsSnapshot());
    },

    refreshModels: async (options) => {
      const { apiKey, models, modelsFetchedAt } = get();
      const stale = modelsFetchedAt === null || Date.now() - modelsFetchedAt > MODELS_TTL_MS;
      if (!options?.force && models.length > 0 && !stale) {
        applySelection();
        return;
      }
      const run = ++modelsRun;
      set({ modelsBusy: true, modelsError: null });
      try {
        // /models is public; the client does not send the key for it.
        const list = await createAiClient(apiKey ?? '').listModels({ imageInput: true });
        if (run !== modelsRun) return;
        const at = Date.now();
        set({ models: list, modelsFetchedAt: at, modelsBusy: false });
        void saveModelsCache({ at, models: list });
      } catch (e) {
        if (run !== modelsRun) return;
        set({
          modelsBusy: false,
          modelsError:
            get().models.length > 0
              ? 'Could not refresh the model list. Showing the saved list.'
              : presentAiError(e, [apiKey]).message,
        });
      }
      applySelection();
    },

    setRememberOnDevice: async (value) => {
      set({ rememberOnDevice: value });
      void savePrefs(prefsSnapshot());
      const key = get().apiKey;
      if (!key || Platform.OS !== 'web') return;
      try {
        await keyStore.save(key, { persist: value });
      } catch {
        set({ error: 'Could not update how the key is stored on this device.' });
      }
    },

    clearError: () => set({ error: null }),
  };
});

/** The selected model object, or null (also null while the catalogue is empty). */
export function selectSelectedModel(state: Pick<AiState, 'models' | 'selectedModelId'>): ModelInfo | null {
  return findSelectedModel(state.models, state.selectedModelId);
}
