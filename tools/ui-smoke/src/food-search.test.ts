/**
 * The rules behind the food search that the Add food screen and the Foods tab share (apps/app/src/components/food/food-search.ts):
 * when a typed text is a search, what the results area shows, when the "Cannot find it?" online card is offered and what it says, what
 * tapping an online result does, the quick-add texts and the Escape key. Pure Node: no React Native is imported.
 */
import { describe, expect, it } from 'vitest';

// The module imports other app modules through the `@/` alias, which vitest resolves but this folder's tsconfig does not: load it at
// run time (same as dashboard-view.test.ts).
const load = (specifier: string): Promise<any> => import(/* @vite-ignore */ specifier);
const {
  MIN_QUERY_LENGTH,
  NO_MEAL_MESSAGE,
  SEARCH_DEBOUNCE_MS,
  clearsOnKey,
  filterFoods,
  isSearchableQuery,
  matchesQuery,
  noFoodsFoundText,
  normalizeQuery,
  onlineImportStep,
  onlineView,
  quickAddCaption,
  quickAddMessage,
  resultsStatus,
  searchView,
} = await load('@/components/food/food-search');

const food = (name: string, brand: string | null = null) => ({ name, brand });
const FOODS = [food('Ćevapi'), food('Chicken breast, roasted, skinless'), food('Yoghurt, plain', 'Meggle'), food('Đuveč')];

describe('query: normalisation and threshold', () => {
  it('a search needs two characters, counted after the spaces around the text are taken off', () => {
    expect(MIN_QUERY_LENGTH).toBe(2);
    expect(SEARCH_DEBOUNCE_MS).toBe(250);
    expect(normalizeQuery('  chicken ')).toBe('chicken');
    expect(normalizeQuery('   ')).toBe('');
    expect(isSearchableQuery(normalizeQuery(''))).toBe(false);
    expect(isSearchableQuery(normalizeQuery('c'))).toBe(false);
    expect(isSearchableQuery(normalizeQuery('  c  '))).toBe(false);
    expect(isSearchableQuery(normalizeQuery('ch'))).toBe(true);
    expect(isSearchableQuery(normalizeQuery(' ch '))).toBe(true);
  });

  it('inner spaces count (and stay): "ri ce" is a search, searched as typed', () => {
    expect(normalizeQuery(' ri ce ')).toBe('ri ce');
    expect(isSearchableQuery('r i')).toBe(true);
  });
});

describe('local filter (the Recent / Favorites / My foods tabs of Add food)', () => {
  it('is accent-insensitive in both directions, also for đ', () => {
    expect(matchesQuery(FOODS[0], 'cevapi')).toBe(true);
    expect(matchesQuery(FOODS[0], 'ĆEVAPI')).toBe(true);
    expect(matchesQuery(FOODS[3], 'duvec')).toBe(true);
    expect(matchesQuery(FOODS[3], 'đuv')).toBe(true);
    expect(matchesQuery(FOODS[1], 'cevapi')).toBe(false);
  });

  it('looks at the brand too and ignores the spaces around the text', () => {
    expect(matchesQuery(FOODS[2], 'meggle')).toBe(true);
    expect(matchesQuery(FOODS[2], '  yoghurt ')).toBe(true);
    expect(matchesQuery(FOODS[1], 'meggle')).toBe(false);
  });

  it('an empty text keeps every food, in order', () => {
    expect(filterFoods(FOODS, '')).toEqual(FOODS);
    expect(filterFoods(FOODS, '   ')).toEqual(FOODS);
    expect(filterFoods(FOODS, 'c').map((f: any) => f.name)).toEqual(['Ćevapi', 'Chicken breast, roasted, skinless', 'Đuveč']);
    expect(filterFoods(FOODS, 'zzz')).toEqual([]);
  });
});

describe('searchView: what the typed text and its debounced copy mean', () => {
  it('too short: not searching, nothing is asked for', () => {
    expect(searchView({ typed: '', debounced: '' })).toEqual({ query: '', request: '', searching: false, settling: false });
    expect(searchView({ typed: 'c', debounced: 'c' })).toEqual({ query: 'c', request: '', searching: false, settling: false });
    expect(searchView({ typed: '  c ', debounced: '  c ' })).toEqual({ query: 'c', request: '', searching: false, settling: false });
  });

  it('long enough and settled: searching, and the text is asked for', () => {
    expect(searchView({ typed: 'chicken', debounced: 'chicken' })).toEqual({ query: 'chicken', request: 'chicken', searching: true, settling: false });
    expect(searchView({ typed: ' chicken ', debounced: 'chicken' })).toEqual({ query: 'chicken', request: 'chicken', searching: true, settling: false });
  });

  it('the results replace the library as soon as the text is long enough, before the debounce has caught up', () => {
    const first = searchView({ typed: 'ch', debounced: '' });
    expect(first).toEqual({ query: '', request: '', searching: true, settling: true });
    const more = searchView({ typed: 'chick', debounced: 'ch' });
    expect(more).toEqual({ query: 'ch', request: 'ch', searching: true, settling: true });
  });

  it('the library is back as soon as the text is short again, even while the debounced copy still holds the old text', () => {
    const cleared = searchView({ typed: '', debounced: 'chicken' });
    expect(cleared.searching).toBe(false);
    expect(cleared.settling).toBe(false);
    expect(searchView({ typed: 'c', debounced: 'chicken' }).searching).toBe(false);
  });

  it('switched off: never searching and nothing asked for (Add food on its Recent / Favorites / My foods tabs)', () => {
    expect(searchView({ typed: 'chicken', debounced: 'chicken', enabled: false })).toEqual({
      query: 'chicken',
      request: '',
      searching: false,
      settling: false,
    });
  });
});

describe('resultsStatus: what the results area shows', () => {
  const base = { searching: true, settling: false, rowCount: 0, isLoading: false, error: null };

  it('idle when not searching, whatever the rest says', () => {
    expect(resultsStatus({ ...base, searching: false })).toBe('idle');
    expect(resultsStatus({ ...base, searching: false, rowCount: 3, error: new Error('x') })).toBe('idle');
  });

  it('rows win: the previous answer stays up while the next one loads', () => {
    expect(resultsStatus({ ...base, rowCount: 2 })).toBe('results');
    expect(resultsStatus({ ...base, rowCount: 2, settling: true })).toBe('results');
    expect(resultsStatus({ ...base, rowCount: 2, isLoading: true })).toBe('results');
    expect(resultsStatus({ ...base, rowCount: 2, error: new Error('x') })).toBe('results');
  });

  it('loading while the debounce runs or the server has not answered: never "nothing found" in between', () => {
    expect(resultsStatus({ ...base, settling: true })).toBe('loading');
    expect(resultsStatus({ ...base, isLoading: true })).toBe('loading');
    expect(resultsStatus({ ...base, settling: true, error: new Error('old') })).toBe('loading');
  });

  it('an error without rows, else nothing found', () => {
    expect(resultsStatus({ ...base, error: new Error('network') })).toBe('error');
    expect(resultsStatus(base)).toBe('empty');
  });

  it('says what was searched for when nothing is found', () => {
    expect(noFoodsFoundText('zzzzzzzz')).toBe('No foods found for \u201Czzzzzzzz\u201D.');
  });
});

describe('onlineView: the "Cannot find it?" card', () => {
  const base = {
    lookupEnabled: true,
    searching: true,
    settling: false,
    searchLoading: false,
    query: 'nutella',
    asked: undefined as string | undefined,
    status: 'idle' as 'idle' | 'pending' | 'error' | 'success',
    resultCount: 0,
  };

  it('is offered under the local answer, when the online lookup is on', () => {
    expect(onlineView(base)).toEqual({ visible: true, outcome: 'none' });
  });

  it('is hidden while nothing is searched, while the local answer loads or the debounce runs, and when the lookup is switched off', () => {
    expect(onlineView({ ...base, searching: false }).visible).toBe(false);
    expect(onlineView({ ...base, searchLoading: true }).visible).toBe(false);
    expect(onlineView({ ...base, settling: true }).visible).toBe(false);
    expect(onlineView({ ...base, lookupEnabled: false }).visible).toBe(false);
  });

  it('says what the online search found, for the text it was asked for', () => {
    expect(onlineView({ ...base, asked: 'nutella', status: 'pending' }).outcome).toBe('none');
    expect(onlineView({ ...base, asked: 'nutella', status: 'error' }).outcome).toBe('error');
    expect(onlineView({ ...base, asked: 'nutella', status: 'success', resultCount: 0 }).outcome).toBe('empty');
    expect(onlineView({ ...base, asked: 'nutella', status: 'success', resultCount: 5 }).outcome).toBe('results');
  });

  it('forgets the outcome once the text is another (or too short): the card goes back to its button', () => {
    expect(onlineView({ ...base, query: 'nutella cream', asked: 'nutella', status: 'success', resultCount: 5 }).outcome).toBe('none');
    expect(onlineView({ ...base, query: 'n', asked: 'n', status: 'success', resultCount: 5 }).outcome).toBe('none');
    expect(onlineView({ ...base, asked: undefined, status: 'success', resultCount: 5 }).outcome).toBe('none');
  });

  it('compares the text as it was sent: spaces around it do not matter', () => {
    expect(onlineView({ ...base, asked: '  nutella ', status: 'success', resultCount: 1 }).outcome).toBe('results');
  });
});

describe('onlineImportStep: tapping an online result', () => {
  it('opens the food that was found or imported', () => {
    expect(onlineImportStep({ status: 'found', foodId: 'f-1', origin: 'remote' })).toEqual({ kind: 'open', foodId: 'f-1' });
    expect(onlineImportStep({ status: 'found', foodId: 'f-2', origin: 'local' })).toEqual({ kind: 'open', foodId: 'f-2' });
  });

  it('says why it did not open', () => {
    expect(onlineImportStep({ status: 'rateLimited', gtin14: '1' })).toEqual({
      kind: 'error',
      message: 'Too many lookups right now. Wait a moment and try again.',
    });
    expect(onlineImportStep({ status: 'unavailable', gtin14: '1', message: 'Online search is not available right now.' })).toEqual({
      kind: 'error',
      message: 'Online search is not available right now.',
    });
    const other = 'Could not load that product. Try another result or create a custom food.';
    expect(onlineImportStep({ status: 'notFound', gtin14: '1' })).toEqual({ kind: 'error', message: other });
    expect(onlineImportStep({ status: 'invalid', message: 'x' })).toEqual({ kind: 'error', message: other });
  });
});

describe('quick add texts', () => {
  it('the toast names the amount, the food, the meal and the day', () => {
    expect(quickAddMessage({ amount: 1, label: 'porcija (10 komada)', name: 'Ćevapi', mealName: 'Dinner', day: 'Today' })).toBe(
      'Added 1 porcija (10 komada) of Ćevapi to Dinner \u00B7 Today',
    );
    expect(quickAddMessage({ amount: 100, label: 'g', name: 'Oats', mealName: undefined, day: 'Yesterday' })).toBe('Added 100 g of Oats to diary \u00B7 Yesterday');
    expect(quickAddMessage({ amount: 0.5, label: 'cup', name: 'Rice', mealName: 'Lunch', day: 'Today' })).toBe('Added 0.5 cup of Rice to Lunch \u00B7 Today');
    expect(quickAddMessage({ amount: 1.256, label: 'slice', name: 'Bread', mealName: 'Lunch', day: 'Today' })).toBe('Added 1.26 slice of Bread to Lunch \u00B7 Today');
  });

  it('the line above the results of the Foods tab says where the + goes', () => {
    expect(quickAddCaption('Snacks', 'Today')).toBe('Quick add goes to Snacks \u00B7 Today');
    expect(quickAddCaption(undefined, 'Today')).toBe('Quick add goes to your diary \u00B7 Today');
  });

  it('without a meal group nothing is added and the person is told', () => {
    expect(NO_MEAL_MESSAGE).toBe('Pick a meal first. No meal group is available yet.');
  });
});

describe('clearsOnKey', () => {
  it('Escape empties a field that has text; nothing else does, and an empty field is left alone', () => {
    expect(clearsOnKey('Escape', 'chicken')).toBe(true);
    expect(clearsOnKey('Escape', '')).toBe(false);
    expect(clearsOnKey('Enter', 'chicken')).toBe(false);
    expect(clearsOnKey('a', 'chicken')).toBe(false);
  });
});
