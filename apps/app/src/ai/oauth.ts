import {
  buildAuthUrl,
  callbackUrlFor,
  createPkcePair,
  createState,
  resolveOAuthReturn,
  type OAuthReturn,
  type PendingOAuth,
} from '@ration/ai';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';

import { ensureAiRuntime } from './runtime';

/**
 * PKCE bookkeeping for "Connect with OpenRouter".
 *  - WEB: full-page redirect. Verifier + state live in sessionStorage for the round trip.
 *  - NATIVE: headless flow (no callback_url, custom URL schemes are not documented as accepted by
 *    OpenRouter). The verifier stays in module memory; the user pastes the code shown by OpenRouter.
 * The verifier is a one-time secret, discarded as soon as the code is exchanged.
 */

const STORAGE_KEY = 'ration.oauth.pending';

/** expo-crypto works on every platform (native CSPRNG; crypto.getRandomValues on web). */
const randomBytes = (length: number): Uint8Array => Crypto.getRandomBytes(length);

let memoryPending: PendingOAuth | null = null;

function webStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function isPending(v: unknown): v is PendingOAuth {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Partial<PendingOAuth>;
  return (
    typeof p.verifier === 'string' &&
    typeof p.state === 'string' &&
    typeof p.startedAt === 'number' &&
    typeof p.persist === 'boolean'
  );
}

function savePending(p: PendingOAuth): void {
  memoryPending = p;
  if (Platform.OS !== 'web') return;
  try {
    webStorage()?.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // sessionStorage unavailable (private mode): the in-memory copy still works without a page reload
  }
}

export function peekPending(): PendingOAuth | null {
  if (Platform.OS === 'web') {
    try {
      const raw = webStorage()?.getItem(STORAGE_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (isPending(parsed)) return parsed;
      }
    } catch {
      // fall through to memory
    }
  }
  return memoryPending;
}

export function clearPending(): void {
  memoryPending = null;
  if (Platform.OS !== 'web') return;
  try {
    webStorage()?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export interface BeginOAuth {
  url: string;
  /** web: navigate the page to `url`; native: open `url` in an in-app browser, then ask for the code. */
  mode: 'redirect' | 'paste';
}

/** Creates the PKCE pair, remembers the verifier and returns the OpenRouter authorisation URL. */
export async function beginOAuth(persist: boolean): Promise<BeginOAuth> {
  ensureAiRuntime(); // PKCE needs TextEncoder
  const pkce = await createPkcePair({ randomBytes });
  const keyLabel = `Ration (${Platform.OS})`;

  if (Platform.OS === 'web') {
    const state = createState(randomBytes);
    savePending({ verifier: pkce.verifier, state, startedAt: Date.now(), persist });
    // OpenRouter accepts the page's own https (or localhost) URL as the callback.
    const callbackUrl = callbackUrlFor(window.location.origin, window.location.pathname);
    return { url: buildAuthUrl({ callbackUrl, challenge: pkce.challenge, state, keyLabel }), mode: 'redirect' };
  }

  savePending({ verifier: pkce.verifier, state: '', startedAt: Date.now(), persist: true });
  return { url: buildAuthUrl({ challenge: pkce.challenge, keyLabel }), mode: 'paste' };
}

/** Web: interprets the current page URL after OpenRouter redirected back. Consumes the pending flow. */
export function consumeWebReturn(url: string): OAuthReturn {
  const result = resolveOAuthReturn(url, peekPending());
  if (result.kind !== 'none') clearPending();
  return result;
}

/** Native: the verifier of the headless flow in progress, if any. */
export function pendingVerifier(): string | null {
  return peekPending()?.verifier ?? null;
}

/** True while a (headless) flow is waiting for the user to paste the code. */
export function hasPendingFlow(): boolean {
  return peekPending() !== null;
}
