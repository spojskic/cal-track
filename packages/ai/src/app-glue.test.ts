import { describe, expect, it } from 'vitest';
import { OpenRouterError } from './errors';
import { presentAiError } from './error-presentation';
import { toFoodCandidate, matchSourceFor } from './food-candidate';
import {
  OAUTH_MAX_AGE_MS,
  callbackUrlFor,
  looksLikeOAuthReturn,
  resolveOAuthReturn,
  stripOAuthParams,
  type PendingOAuth,
} from './oauth-flow';
import { matchItems, type MatchDeps } from './pipeline';
import type { ParsedMealItem } from './schemas';

const pending: PendingOAuth = { verifier: 'v'.repeat(43), state: 'st4te', startedAt: 1_000_000, persist: true };
const NOW = pending.startedAt + 60_000;

describe('looksLikeOAuthReturn', () => {
  it('detects code and error params only', () => {
    expect(looksLikeOAuthReturn('https://x.app/settings/ai?code=abc')).toBe(true);
    expect(looksLikeOAuthReturn('https://x.app/settings/ai?foo=1&error=access_denied')).toBe(true);
    expect(looksLikeOAuthReturn('https://x.app/settings/ai')).toBe(false);
    expect(looksLikeOAuthReturn('https://x.app/settings/ai?codex=1')).toBe(false);
    expect(looksLikeOAuthReturn('https://x.app/settings/ai#code=abc')).toBe(false);
  });
});

describe('resolveOAuthReturn', () => {
  it('ignores URLs that are not a return, or when nothing is pending', () => {
    expect(resolveOAuthReturn('https://x.app/settings/ai', pending, NOW)).toEqual({ kind: 'none' });
    expect(resolveOAuthReturn('https://x.app/settings/ai?code=abc', null, NOW)).toEqual({ kind: 'none' });
  });

  it('returns the code with the saved verifier when state matches', () => {
    expect(resolveOAuthReturn('https://x.app/settings/ai?code=abc123&state=st4te', pending, NOW)).toEqual({
      kind: 'code',
      code: 'abc123',
      verifier: pending.verifier,
      persist: true,
    });
  });

  it('accepts a callback that does not echo state (PKCE still binds the code)', () => {
    const r = resolveOAuthReturn('https://x.app/settings/ai?code=abc123', pending, NOW);
    expect(r).toMatchObject({ kind: 'code', code: 'abc123' });
  });

  it('rejects an echoed state that differs', () => {
    const r = resolveOAuthReturn('https://x.app/settings/ai?code=abc123&state=evil', pending, NOW);
    expect(r.kind).toBe('error');
  });

  it('reports denial', () => {
    const r = resolveOAuthReturn('https://x.app/settings/ai?error=access_denied&state=st4te', pending, NOW);
    expect(r).toMatchObject({ kind: 'error' });
  });

  it('rejects an expired flow', () => {
    const r = resolveOAuthReturn(
      'https://x.app/settings/ai?code=abc123',
      pending,
      pending.startedAt + OAUTH_MAX_AGE_MS + 1,
    );
    expect(r.kind).toBe('error');
  });
});

describe('stripOAuthParams / callbackUrlFor', () => {
  it('removes only OAuth params', () => {
    expect(stripOAuthParams('https://x.app/settings/ai?code=a&state=b')).toBe('https://x.app/settings/ai');
    expect(stripOAuthParams('https://x.app/settings/ai?tab=models&code=a&state=b#top')).toBe(
      'https://x.app/settings/ai?tab=models#top',
    );
    expect(stripOAuthParams('https://x.app/settings/ai?error=denied&error_description=no')).toBe(
      'https://x.app/settings/ai',
    );
    expect(stripOAuthParams('https://x.app/settings/ai')).toBe('https://x.app/settings/ai');
  });

  it('builds the callback from origin + path', () => {
    expect(callbackUrlFor('https://x.app/', '/settings/ai')).toBe('https://x.app/settings/ai');
    expect(callbackUrlFor('http://localhost:8081', 'settings/ai')).toBe('http://localhost:8081/settings/ai');
  });
});

describe('food candidate glue', () => {
  it('maps database sources to matcher weight keys', () => {
    expect(matchSourceFor('fdc_foundation')).toBe('usda');
    expect(matchSourceFor('fdc_branded')).toBe('usda');
    expect(matchSourceFor('custom')).toBe('user');
    expect(matchSourceFor('recipe')).toBe('user');
    expect(matchSourceFor('ai_estimate')).toBe('ai');
    expect(matchSourceFor('cnf')).toBe('cnf');
    expect(matchSourceFor('off')).toBe('off');
  });

  it('sanitises numbers and flags user-owned kinds only', () => {
    const c = toFoodCandidate({
      id: 'a',
      name: 'Ćevapi',
      brand: null,
      kind: 'custom',
      source: 'custom',
      kcal100g: null,
      completeness: 7,
    });
    expect(c).toMatchObject({ source: 'user', kcal100g: 0, completeness: 1, isUserFood: true });
    expect('brand' in c).toBe(false);
    const ai = toFoodCandidate({ id: 'b', name: 'x', kind: 'ai_estimate', source: 'ai_estimate', kcal100g: 100, completeness: 0.3 });
    expect(ai.isUserFood).toBe(false);
  });

  it('a real database food beats a prior AI estimate with the same name', async () => {
    const item: ParsedMealItem = {
      name: 'chicken breast',
      searchTerms: ['chicken breast'],
      grams: 150,
      confidence: 0.9,
    };
    const rows = [
      { id: 'ai', name: 'Chicken breast', kind: 'ai_estimate', source: 'ai_estimate', kcal100g: 150, completeness: 0.2 },
      { id: 'usda', name: 'Chicken breast', kind: 'generic', source: 'fdc_foundation', kcal100g: 165, completeness: 0.9 },
    ];
    const deps: MatchDeps = { searchFoods: async () => rows.map(toFoodCandidate) };
    const [m] = await matchItems([item], deps);
    expect(m?.best?.id).toBe('usda');
    expect(m?.alternatives.map((a) => a.id)).toContain('ai');
  });
});

describe('presentAiError', () => {
  it('uses the friendly message and flags model-specific failures', () => {
    const p = presentAiError(new OpenRouterError({ kind: 'invalid_output' }));
    expect(p.tryAnotherModel).toBe(true);
    expect(p.hint).toMatch(/another model/i);
    expect(presentAiError(new OpenRouterError({ kind: 'auth' })).needsReconnect).toBe(true);
    expect(presentAiError(new OpenRouterError({ kind: 'network' })).tryAnotherModel).toBe(false);
  });

  it('redacts keys from unknown errors', () => {
    const p = presentAiError(new Error('boom sk-or-v1-abcdef123456 Bearer abc.def'), ['abc.def']);
    expect(p.message).not.toContain('sk-or-v1-abcdef123456');
    expect(p.message).not.toContain('abc.def');
    expect(p.kind).toBe('unknown');
  });

  it('treats aborts as a quiet cancel', () => {
    const e = new Error('x');
    e.name = 'AbortError';
    expect(presentAiError(e).kind).toBe('aborted');
  });
});
