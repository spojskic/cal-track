// Text of a diary entry row, as plain data (no React) so the rules are unit tested in tools/ui-smoke.
import { formatNumber } from '@/components/charts/format';
import type { DiaryEntry } from '@/data/diary';

/** "2 x slice" for portion entries, otherwise "150 g". */
export function entryAmountLabel(entry: Pick<DiaryEntry, 'grams' | 'amount' | 'portionLabel'>): string {
  const label = entry.portionLabel?.trim();
  if (entry.amount && label && label.toLowerCase() !== 'g') {
    return `${formatNumber(entry.amount, 2, true)} x ${label}`;
  }
  return `${formatNumber(entry.grams, entry.grams < 10 ? 1 : 0, true)} g`;
}

export interface EntryRowText {
  /** Food name (bold). */
  name: string;
  /** Muted line under the name: "60 g" or "60 g - Brand". */
  serving: string;
  /** Right column, first line: "483" or "-" when the energy is unknown. */
  kcal: string;
  /** Accessible name of the whole row. */
  label: string;
}

export function entryRowText(
  entry: Pick<DiaryEntry, 'grams' | 'amount' | 'portionLabel' | 'kcal'> & { food: Pick<DiaryEntry['food'], 'name' | 'brand'> },
): EntryRowText {
  const amount = entryAmountLabel(entry);
  const brand = entry.food.brand?.trim() || undefined;
  const kcal = entry.kcal === undefined ? '-' : formatNumber(entry.kcal);
  return {
    name: entry.food.name,
    serving: brand ? `${amount} \u00B7 ${brand}` : amount,
    kcal,
    // "<food>, <brand>, <amount>, <n> kilocalories": the smoke scenarios find the rows by the start of this name.
    label: `${entry.food.name}${brand ? `, ${brand}` : ''}, ${amount}, ${
      entry.kcal === undefined ? 'energy unknown' : `${kcal} kilocalories`
    }. Double tap to edit.`,
  };
}
