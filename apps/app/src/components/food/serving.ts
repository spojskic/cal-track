import { useState } from 'react';
import { G_PER_OZ, gramsFromVolume, convertVolume, parseNumber } from '@cal/core';

import type { FoodPortion } from '@/data/foods';

import { trimNumber } from './format';

/** One selectable unit in the serving picker. `gramsPerUnit` is the mass of ONE unit. */
export interface ServingOption {
  key: string;
  label: string;
  gramsPerUnit: number;
  kind: 'portion' | 'mass' | 'volume';
  /** Amount prefilled when the user picks this unit without typing a number first. */
  defaultAmount: number;
}

/**
 * Units for a food: its portions, grams and ounces, and ml / cup / tbsp / tsp / fl oz ONLY when the
 * food has a known density (g/ml).
 */
export function buildServingOptions(
  portions: FoodPortion[],
  densityGPerMl: number | null,
  imperial = false,
): ServingOption[] {
  const options: ServingOption[] = portions.map((p) => ({
    key: `p:${p.id}`,
    label: p.unitLabel,
    gramsPerUnit: p.gramsPerUnit,
    kind: 'portion',
    defaultAmount: p.defaultAmount,
  }));

  const grams: ServingOption = { key: 'g', label: 'g', gramsPerUnit: 1, kind: 'mass', defaultAmount: 100 };
  const ounces: ServingOption = { key: 'oz', label: 'oz', gramsPerUnit: G_PER_OZ, kind: 'mass', defaultAmount: 1 };
  // Some sources already ship "100 g" / "1 oz" portions: do not list them twice.
  const have = new Set(options.map((o) => o.label.toLowerCase()));
  options.push(...(imperial ? [ounces, grams] : [grams, ounces]).filter((o) => !have.has(o.label)));

  if (densityGPerMl && densityGPerMl > 0) {
    const taken = new Set(options.map((o) => o.label.toLowerCase()));
    const volume: { key: string; label: string; ml: number; amount: number }[] = [
      { key: 'ml', label: 'ml', ml: 1, amount: 100 },
      { key: 'cup', label: 'cup', ml: convertVolume(1, 'cup', 'ml'), amount: 1 },
      { key: 'tbsp', label: 'tbsp', ml: convertVolume(1, 'tbsp', 'ml'), amount: 1 },
      { key: 'tsp', label: 'tsp', ml: convertVolume(1, 'tsp', 'ml'), amount: 1 },
      { key: 'fl_oz', label: 'fl oz', ml: convertVolume(1, 'fl_oz', 'ml'), amount: 1 },
    ];
    for (const v of volume) {
      if (taken.has(v.label)) continue;
      options.push({
        key: `v:${v.key}`,
        label: v.label,
        gramsPerUnit: gramsFromVolume(v.ml, densityGPerMl),
        kind: 'volume',
        defaultAmount: v.amount,
      });
    }
  }
  return options;
}

interface InitialServing {
  /** Prefill by total grams (e.g. editing a diary entry). */
  grams?: number;
  /** Portion label to preselect (matches unit label, row label or key). */
  portion?: string;
}

function initialChoice(options: ServingOption[], initial?: InitialServing): { key: string; amount: number } {
  const byPortion = initial?.portion
    ? options.find((o) => {
        const wanted = initial.portion?.trim().toLowerCase();
        return o.key === initial.portion || o.label.toLowerCase() === wanted;
      })
    : undefined;
  if (byPortion) {
    const amount =
      initial?.grams && initial.grams > 0 ? initial.grams / byPortion.gramsPerUnit : byPortion.defaultAmount;
    return { key: byPortion.key, amount };
  }
  if (initial?.grams && initial.grams > 0) {
    const g = options.find((o) => o.key === 'g' || (o.label.toLowerCase() === 'g' && Math.abs(o.gramsPerUnit - 1) < 1e-6));
    if (g) return { key: g.key, amount: initial.grams };
  }
  const first =
    options.find((o) => o.kind === 'portion') ?? options.find((o) => o.key === 'g') ?? options[0];
  return { key: first?.key ?? 'g', amount: first?.defaultAmount ?? 100 };
}

/**
 * State for an amount + unit pair that converts to grams. Choosing another unit keeps a number the
 * user typed but replaces an untouched default with the new unit's default.
 */
export function useServing(options: ServingOption[], initial?: InitialServing) {
  const [state, setState] = useState(() => {
    const c = initialChoice(options, initial);
    return { key: c.key, amountText: trimNumber(c.amount), touched: false };
  });

  const selected = options.find((o) => o.key === state.key) ?? options[0];
  const amount = parseNumber(state.amountText);
  const grams = selected && amount !== null && amount > 0 ? amount * selected.gramsPerUnit : null;

  return {
    selected,
    amount,
    amountText: state.amountText,
    grams,
    setAmountText: (text: string) => setState((s) => ({ ...s, amountText: text, touched: true })),
    select: (opt: ServingOption) =>
      setState((s) => ({
        key: opt.key,
        amountText: s.touched ? s.amountText : trimNumber(opt.defaultAmount),
        touched: s.touched,
      })),
  };
}
