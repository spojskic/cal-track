// How one macro row of the targets is drawn, as plain data (no React) so the rules are unit tested in tools/ui-smoke.
import { formatNumber } from '@/components/charts/format';

export type PercentTone = 'muted' | 'success' | 'danger';

/**
 * Colour of the percentage next to a bar. `overIsBad` marks a LIMIT (energy, carbs, fat): being at the limit is fine,
 * only going past it is bad (danger). Otherwise it is a goal (protein): 100 % or more is reached (success).
 * Decided on the rounded percentage, so a bar that reads "100 %" never shows up red.
 */
export function percentTone(pct: number | undefined, overIsBad: boolean): PercentTone {
  if (pct === undefined) return 'muted';
  const percent = Math.round(pct * 100);
  if (overIsBad) return percent > 100 ? 'danger' : 'muted';
  return percent >= 100 ? 'success' : 'muted';
}

export interface MacroProgressInput {
  value: number | undefined;
  target?: number | undefined;
  unit: string;
  /** Energy after exercise ("net"). When set it drives the bar and percentage; `value` is shown in front of it. */
  netValue?: number | undefined;
  decimals?: number;
  overIsBad?: boolean;
}

export interface MacroProgress {
  /** Share of the target (1 = 100 %); undefined without a target or an amount. */
  pct: number | undefined;
  /** "104%", empty when unknown. */
  pctText: string;
  tone: PercentTone;
  /** Filled share of the track in the macro colour (0..1). */
  mainFill: number;
  /** Share of the track filled past the target (0..1), drawn in the over colour. */
  overFill: number;
  /** Where the target sits on the track (0..1) when the bar is past it, otherwise undefined. */
  markAt: number | undefined;
  /** "2,376 (2,100 net) / 2,195 kcal" - the part after the label. */
  valueText: string;
  /** 0..100 for the progressbar accessibility value; undefined when unknown. */
  now: number | undefined;
}

/**
 * Past 100 % the track is rescaled (up to twice the target) so the target position is marked by a notch and the
 * overflow is drawn in the over colour.
 */
export function macroProgress(input: MacroProgressInput): MacroProgress {
  const { value, target, netValue, unit, decimals = 0, overIsBad = true } = input;
  const driver = netValue ?? value;
  const hasTarget = typeof target === 'number' && target > 0;
  const pct = hasTarget && driver !== undefined ? Math.max(0, driver) / target : undefined;
  const over = pct !== undefined && pct > 1;
  const scale = Math.min(2, Math.max(1, pct ?? 1));

  const amount = formatNumber(value, decimals, true);
  const net = netValue !== undefined ? ` (${formatNumber(netValue, decimals, true)} net)` : '';
  return {
    pct,
    pctText: pct === undefined ? '' : `${Math.round(pct * 100)}%`,
    tone: percentTone(pct, overIsBad),
    mainFill: pct === undefined ? 0 : Math.min(pct, 1) / scale,
    overFill: over ? (Math.min(pct, 2) - 1) / scale : 0,
    markAt: over ? 1 / scale : undefined,
    valueText: hasTarget ? `${amount}${net} / ${formatNumber(target, decimals, true)} ${unit}` : `${amount}${net} ${unit}`,
    now: pct === undefined ? undefined : Math.min(100, Math.round(pct * 100)),
  };
}
