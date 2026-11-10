// react-query hooks for the direct Garmin Connect link (OAuth). Everything is behind GARMIN_ENABLED
// (EXPO_PUBLIC_GARMIN_ENABLED=true): with the flag off no query is enabled and nothing Garmin related is called.
// The server side is supabase/functions/garmin-* ; the app never sees a Garmin token, only the connection status.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import {
  GARMIN_ENABLED,
  describeGarminFunctionError,
  parseGarminReturnUrl,
  parseGarminStatus,
  type GarminReturn,
  type GarminStatus,
} from '@/health/garmin';
import { requireUserId } from '@/lib/auth-user';
import { supabase } from '@/lib/supabase';

import { useUserId } from './profile';

export type { GarminStatus };

/** Includes the user id so a cached status never leaks across accounts (same convention as profileKey). */
export const garminStatusKey = (userId: string | undefined) => ['garmin', 'status', userId ?? 'anon'] as const;

/** The signed-in user's Garmin connection (rpc garmin_connection_status: four columns, never a token). */
export function useGarminStatus() {
  const userId = useUserId();
  return useQuery({
    queryKey: garminStatusKey(userId),
    enabled: GARMIN_ENABLED && Boolean(userId),
    queryFn: async (): Promise<GarminStatus> => {
      const { data, error } = await supabase.rpc('garmin_connection_status');
      if (error) throw error;
      return parseGarminStatus(data);
    },
  });
}

/**
 * Where the callback sends the browser back to on a phone: `<app scheme>://settings/integrations` (scheme from app.json,
 * `caltrack`). It must match the server's GARMIN_APP_REDIRECT, whose default is exactly this. Built from the config instead of
 * Linking.createURL(), which returns a different scheme inside development clients and would never match.
 */
function nativeReturnUrl(): string {
  const scheme = Constants.expoConfig?.scheme;
  return `${(Array.isArray(scheme) ? scheme[0] : scheme) ?? 'caltrack'}://settings/integrations`;
}

interface FunctionFailure {
  status: number | null;
  error: string | null;
}

/** supabase-js wraps non-2xx answers in FunctionsHttpError with the Response in `context`. */
async function readFunctionFailure(error: unknown): Promise<FunctionFailure> {
  const e = error as { name?: string; context?: unknown } | null;
  const ctx = e?.context as Response | undefined;
  if (e?.name === 'FunctionsHttpError' && ctx && typeof ctx.status === 'number') {
    let code: string | null = null;
    try {
      const body: unknown = await ctx.json();
      if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
        code = (body as { error: string }).error;
      }
    } catch {
      code = null;
    }
    return { status: ctx.status, error: code };
  }
  return { status: null, error: null };
}

async function invokeGarmin(name: 'garmin-oauth-start' | 'garmin-disconnect', body: Record<string, unknown>): Promise<unknown> {
  let res: { data: unknown; error: unknown };
  try {
    res = await supabase.functions.invoke(name, { body });
  } catch {
    throw new Error(describeGarminFunctionError({ status: null }));
  }
  if (res.error) throw new Error(describeGarminFunctionError(await readFunctionFailure(res.error)));
  return res.data;
}

/**
 * One tap: asks `garmin-oauth-start` for Garmin's authorize page and opens it.
 *  - web: this page is replaced by Garmin's; afterwards the browser returns to /settings/integrations?garmin=connected|error
 *    (the screen reads the params).
 *  - iOS / Android: an in-app auth session; it ends when Garmin's callback redirects to the app's deep link, and the
 *    mutation resolves with what the redirect said (null when the user closed the browser).
 */
export function useConnectGarmin() {
  const qc = useQueryClient();
  const userId = useUserId();
  return useMutation({
    mutationFn: async (): Promise<GarminReturn | null> => {
      await requireUserId();
      const data = await invokeGarmin('garmin-oauth-start', { platform: Platform.OS === 'web' ? 'web' : 'native' });
      const url = (data as { url?: unknown } | null)?.url;
      if (typeof url !== 'string' || !url) throw new Error('Garmin did not return a sign-in address. Please try again.');

      if (Platform.OS === 'web') {
        window.location.assign(url); // leaves the page; the screen finishes the flow when Garmin sends the browser back
        return null;
      }
      const result = await WebBrowser.openAuthSessionAsync(url, nativeReturnUrl());
      return result.type === 'success' ? parseGarminReturnUrl(result.url) : null;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: garminStatusKey(userId) }),
  });
}

/**
 * Deregisters at Garmin (best effort) and deletes the server-side link and tokens. With `deleteData` the rows imported from
 * Garmin (source = 'garmin') are removed too; otherwise they stay in the diary.
 */
export function useDisconnectGarmin() {
  const qc = useQueryClient();
  const userId = useUserId();
  return useMutation({
    mutationFn: async (input: { deleteData: boolean }): Promise<{ deregistered: boolean }> => {
      await requireUserId();
      const data = await invokeGarmin('garmin-disconnect', { deleteData: input.deleteData });
      return { deregistered: (data as { deregistered?: unknown } | null)?.deregistered === true };
    },
    onSuccess: (_result, input) => {
      void qc.invalidateQueries({ queryKey: garminStatusKey(userId) });
      // Imported Garmin rows feed the diary, energy and biometric queries.
      if (input.deleteData) {
        void qc.invalidateQueries({ queryKey: ['day'] });
        void qc.invalidateQueries({ queryKey: ['biometrics'] });
      }
    },
  });
}
