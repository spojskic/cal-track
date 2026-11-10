/**
 * "Scan nutrition label": the pure app side, run through the app's own modules via the `@/` alias.
 *
 *  - state/label-draft.ts: the in-memory hand-over from the scan to the New food screen (set / replace / clear, ids,
 *    copy on the way in) and formInitialFromDraft (what the food form is given)
 *  - the chain reading -> draft (packages/core) -> store -> form values, with the numbers of real label layouts
 *
 * The screens themselves (camera, food form, buttons) need a browser and an AI key; the web run covers their GATED
 * state (no key: the button and the action are absent, /ai/label shows "AI is not set up").
 *
 * Skipped when the app's dependencies are not installed.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const appRequire = createRequire(join(here, '..', '..', '..', 'apps', 'app', 'package.json'));

const hasZustand = (() => {
  try {
    appRequire.resolve('zustand');
    return true;
  } catch {
    return false;
  }
})();
const suite = hasZustand ? describe : describe.skip;

/** App modules are untyped here on purpose (this package's tsconfig knows nothing about React Native). */
const load = (specifier: string): Promise<any> => import(/* @vite-ignore */ specifier);
const core = (): Promise<any> => import('../../../packages/core/src');

/** A draft as labelToFoodDraft produces it (EU label, per 100 g, one unsure value). */
function draft(over: Record<string, unknown> = {}): any {
  return {
    name: 'Choco Spread',
    brand: 'Acme',
    basis: 'per100g',
    nutrients: { ENERGY_KCAL: 539, FAT_G: 30.9, CARBS_G: 57.5, PROTEIN_G: 6.3, SODIUM_MG: 42.8 },
    carbBasis: 'excludes_fiber',
    densityGPerMl: null,
    servings: [{ name: 'tbsp', grams: 15 }],
    unclear: ['SODIUM_MG'],
    unclearFields: ['brand'],
    notes: ['The label lists salt, not sodium. Sodium was calculated from it (salt divided by 2.5).'],
    ...over,
  };
}

suite('state/label-draft.ts: the hand-over to the New food screen', () => {
  afterEach(async () => {
    const { clearLabelDraft } = await load('@/state/label-draft');
    clearLabelDraft();
  });

  it('starts empty, stores a draft with an id, and replaces it with the next scan', async () => {
    const { setLabelDraft, useLabelDraft } = await load('@/state/label-draft');
    expect(useLabelDraft.getState().current).toBeNull();

    const first = setLabelDraft(draft());
    expect(first.draft).toEqual(draft());
    expect(useLabelDraft.getState().current).toBe(first);

    const second = setLabelDraft(draft({ name: 'Other' }));
    expect(second.id).toBeGreaterThan(first.id); // a screen that is open can tell the new draft from the one it shows
    expect(useLabelDraft.getState().current?.draft.name).toBe('Other');
  });

  it('gives every scan its own id, also after the draft was cleared', async () => {
    const { setLabelDraft, clearLabelDraft } = await load('@/state/label-draft');
    const ids = new Set<number>();
    for (let i = 0; i < 5; i++) {
      ids.add(setLabelDraft(draft()).id);
      if (i % 2 === 0) clearLabelDraft();
    }
    expect(ids.size).toBe(5);
  });

  it('is cleared when the New food screen closes, and clearing twice is harmless', async () => {
    const { setLabelDraft, clearLabelDraft, useLabelDraft } = await load('@/state/label-draft');
    setLabelDraft(draft());
    clearLabelDraft();
    expect(useLabelDraft.getState().current).toBeNull();
    const listener = vi.fn();
    const unsubscribe = useLabelDraft.subscribe(listener);
    clearLabelDraft(); // nothing to clear: nobody is notified
    expect(listener).not.toHaveBeenCalled();
    setLabelDraft(draft());
    expect(listener).toHaveBeenCalledTimes(1);
    clearLabelDraft();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('keeps its own copy: changing the scan result afterwards does not change what the form shows', async () => {
    const { setLabelDraft, useLabelDraft } = await load('@/state/label-draft');
    const source = draft();
    setLabelDraft(source);
    source.nutrients.ENERGY_KCAL = 1;
    source.unclear.push('FAT_G');
    source.notes.length = 0;
    const stored = useLabelDraft.getState().current.draft;
    expect(stored.nutrients.ENERGY_KCAL).toBe(539);
    expect(stored.unclear).toEqual(['SODIUM_MG']);
    expect(stored.notes).toHaveLength(1);
  });
});

suite('state/label-draft.ts: formInitialFromDraft', () => {
  it('gives the food form everything the label said', async () => {
    const { formInitialFromDraft } = await load('@/state/label-draft');
    expect(formInitialFromDraft(draft())).toEqual({
      name: 'Choco Spread',
      brand: 'Acme',
      basis: 'per100g',
      nutrients: { ENERGY_KCAL: 539, FAT_G: 30.9, CARBS_G: 57.5, PROTEIN_G: 6.3, SODIUM_MG: 42.8 },
      carbBasis: 'excludes_fiber',
      densityGPerMl: null,
      servings: [{ name: 'tbsp', grams: 15 }],
      unclear: ['SODIUM_MG'],
      unclearFields: ['brand'],
      expandFilled: true,
    });
  });

  it('carries the barcode and falls back to a typed name only when the label has none', async () => {
    const { formInitialFromDraft } = await load('@/state/label-draft');
    expect(formInitialFromDraft(draft(), { name: 'Typed', gtin: '3017620422003' })).toMatchObject({ name: 'Choco Spread', gtin: '3017620422003' });
    const nameless = formInitialFromDraft(draft({ name: null, brand: null, unclearFields: ['name', 'serving'] }), { name: 'Typed' });
    expect(nameless.name).toBe('Typed');
    expect(nameless).not.toHaveProperty('brand');
    // the name from the URL is the user's own: it is not marked "check this"
    expect(nameless.unclearFields).toEqual(['serving']);
    expect(formInitialFromDraft(draft({ name: null }))).not.toHaveProperty('name');
    expect(formInitialFromDraft(draft())).not.toHaveProperty('gtin');
  });

  it('keeps a per-serving label per serving, also when the serving size is still unknown', async () => {
    const { formInitialFromDraft } = await load('@/state/label-draft');
    const perServing = formInitialFromDraft(
      draft({ basis: 'perServing', servings: [{ name: 'serving', grams: null }], unclearFields: ['serving'], densityGPerMl: 1 }),
    );
    expect(perServing.basis).toBe('perServing');
    expect(perServing.servings).toEqual([{ name: 'serving', grams: null }]);
    expect(perServing.densityGPerMl).toBe(1);
    expect(perServing.unclearFields).toEqual(['serving']);
  });

  it('counts the values that carry a "check this" marker (the banner says how many)', async () => {
    const { markedValueCount } = await load('@/state/label-draft');
    expect(markedValueCount(draft())).toBe(2); // sodium + brand
    expect(markedValueCount(draft({ unclear: [], unclearFields: [] }))).toBe(0);
    // a flagged name that the label did not give is not marked in the form, so it is not counted either
    expect(markedValueCount(draft({ name: null, unclear: ['FAT_G', 'PROTEIN_G'], unclearFields: ['name', 'carbBasis'] }))).toBe(3);
  });

  it('does not change the draft it is given', async () => {
    const { formInitialFromDraft } = await load('@/state/label-draft');
    const source = draft();
    const copy = JSON.parse(JSON.stringify(source));
    formInitialFromDraft(source, { name: 'x', gtin: '1' });
    expect(source).toEqual(copy);
  });
});

suite('reading -> draft -> store -> form values', () => {
  afterEach(async () => {
    const { clearLabelDraft } = await load('@/state/label-draft');
    clearLabelDraft();
  });

  const row = (key: string, amount: number, unit: string, unclear = false) => ({ key, amount, unit, unclear });
  const reading = (over: Record<string, unknown>) => ({
    productName: null,
    brand: null,
    basis: 'per_100g',
    serving: { amount: null, unit: null, text: null },
    servingsPerContainer: null,
    carbohydrateIncludesFibre: null,
    nutrients: [],
    unclearFields: [],
    notes: null,
    warnings: [],
    ...over,
  });

  it('a US per-serving label: values stay as printed, the serving carries its grams, sodium in mg', async () => {
    const { labelToFoodDraft, NUTRIENT_BY_CODE } = await core();
    const { setLabelDraft, formInitialFromDraft, useLabelDraft } = await load('@/state/label-draft');
    const read = reading({
      basis: 'per_serving',
      serving: { amount: 55, unit: 'g', text: '2/3 cup (55g)' },
      carbohydrateIncludesFibre: true,
      nutrients: [
        row('energy_kcal', 230, 'kcal'),
        row('fat', 8, 'g'),
        row('sodium', 0.16, 'g'),
        row('carbohydrate', 37, 'g'),
        row('fibre', 4, 'g'),
        row('added_sugars', 12, 'g', true),
        row('protein', 3, 'g'),
        row('vitamin_d', 80, 'iu'),
        row('calcium', 260, 'mg'),
      ],
    });
    setLabelDraft(labelToFoodDraft(read));
    const initial = formInitialFromDraft(useLabelDraft.getState().current.draft);
    expect(initial).toMatchObject({
      basis: 'perServing',
      carbBasis: 'includes_fiber',
      servings: [{ name: '2/3 cup', grams: 55 }],
      unclear: ['ADDED_SUGARS_G'],
      expandFilled: true,
    });
    expect(initial.nutrients).toEqual({
      ENERGY_KCAL: 230,
      FAT_G: 8,
      SODIUM_MG: 160,
      CARBS_G: 37,
      FIBER_G: 4,
      ADDED_SUGARS_G: 12,
      PROTEIN_G: 3,
      VITAMIN_D_UG: 2,
      CALCIUM_MG: 260,
    });
    for (const code of Object.keys(initial.nutrients)) expect(NUTRIENT_BY_CODE[code], code).toBeDefined();
  });

  it('an EU label in kJ and salt: the form gets kcal and sodium, a note says how', async () => {
    const { labelToFoodDraft } = await core();
    const { formInitialFromDraft, setLabelDraft, useLabelDraft } = await load('@/state/label-draft');
    const read = reading({
      productName: 'Jogurt',
      basis: 'per_100g',
      carbohydrateIncludesFibre: false,
      nutrients: [row('energy_kj', 255, 'kj'), row('fat', 3.2, 'g'), row('carbohydrate', 4.7, 'g'), row('sugars', 4.7, 'g'), row('protein', 3.4, 'g'), row('salt', 0.1, 'g')],
    });
    const stored = setLabelDraft(labelToFoodDraft(read));
    expect(stored.draft.notes).toEqual([
      'Energy is printed in kJ only. It was converted to kcal (kJ divided by 4.184).',
      'The label lists salt, not sodium. Sodium was calculated from it (salt divided by 2.5).',
    ]);
    const initial = formInitialFromDraft(useLabelDraft.getState().current.draft, { gtin: '3017 6204 22003' });
    expect(initial).toMatchObject({ name: 'Jogurt', gtin: '3017 6204 22003', basis: 'per100g', carbBasis: 'excludes_fiber', unclear: [] });
    expect(initial.nutrients).toEqual({ ENERGY_KCAL: 61, FAT_G: 3.2, CARBS_G: 4.7, SUGARS_G: 4.7, PROTEIN_G: 3.4, SODIUM_MG: 40 });
  });
});
