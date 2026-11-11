// Text of the exercise / biometric / note rows of a diary day, as plain data (no React) so it is unit tested in
// tools/ui-smoke.
import { formatWeight, type UnitSystem } from '@ration/core';

import { formatNumber } from '@/components/charts/format';
import type { BiometricEntry, ExerciseEntry, NoteEntry } from '@/data/activity';

export interface ActivityRowText {
  title: string;
  /** Muted line under the title. */
  detail?: string;
  /** Right column: the value and, when it has one, a muted unit line under it ("-163" / "kcal"). */
  value?: string;
  unit?: string;
  /** What the toast says: "Deleted <name>". */
  deleteName: string;
}

export function sourceName(source: string): string {
  switch (source) {
    case 'garmin':
      return 'Garmin';
    case 'apple_health':
      return 'Apple Health';
    case 'health_connect':
      return 'Health Connect';
    default:
      return 'Misc';
  }
}

export function prettifyType(type: string): string {
  const spaced = type.replace(/_/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Exercise: "Running", "45 min - Garmin", burned energy as negative kcal. */
export function exerciseRowText(e: Pick<ExerciseEntry, 'name' | 'minutes' | 'source' | 'kcal' | 'counts_toward_energy'>): ActivityRowText {
  const bits = [
    e.minutes ? `${formatNumber(e.minutes, 0, true)} min` : undefined,
    e.source !== 'manual' ? sourceName(e.source) : undefined,
    !e.counts_toward_energy ? 'not counted' : undefined,
  ].filter(Boolean);
  return {
    title: e.name,
    ...(bits.length > 0 ? { detail: bits.join(' - ') } : {}),
    value: formatNumber(-Number(e.kcal)),
    unit: 'kcal',
    deleteName: e.name,
  };
}

function biometricValue(b: Pick<BiometricEntry, 'type' | 'unit' | 'value'>, system: UnitSystem): string {
  const unit = (b.unit ?? '').toLowerCase();
  if (b.type === 'weight' && (unit === '' || unit === 'kg')) return formatWeight(Number(b.value), system);
  return `${formatNumber(Number(b.value), 1, true)}${b.unit ? ` ${b.unit}` : ''}`;
}

/** Biometric: "Weight" with its value ("80.5 kg", "176.5 lb" in imperial). */
export function biometricRowText(b: Pick<BiometricEntry, 'type' | 'unit' | 'value' | 'source'>, system: UnitSystem): ActivityRowText {
  const title = prettifyType(b.type);
  return {
    title,
    ...(b.source !== 'manual' ? { detail: sourceName(b.source) } : {}),
    value: biometricValue(b, system),
    deleteName: title,
  };
}

/** Note: the text itself. */
export function noteRowText(n: Pick<NoteEntry, 'body'>): ActivityRowText {
  return { title: n.body, deleteName: 'note' };
}

/** Accessible name of a row: "Running, 45 min, -163 kcal". */
export function activityRowLabel(text: ActivityRowText): string {
  const value = text.value ? `${text.value}${text.unit ? ` ${text.unit}` : ''}` : undefined;
  return [text.title, text.detail, value].filter(Boolean).join(', ');
}
