import type { ModelInfo } from '@cal/ai';

/** 1_000_000 -> "1M", 128_000 -> "128K", 0 -> "?". */
export function formatContext(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '?';
  if (tokens >= 1_000_000) return `${trim(tokens / 1_000_000)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

function trim(n: number): string {
  return String(Number(n.toFixed(1)));
}

/** USD per million tokens: "$0.30", "$12", "Free" or "?" when unknown. */
export function formatPricePerM(price: number | null): string {
  if (price === null || !Number.isFinite(price)) return '?';
  if (price === 0) return 'Free';
  if (price < 0.1) return `$${price.toFixed(3)}`;
  if (price < 10) return `$${price.toFixed(2)}`;
  return `$${Math.round(price)}`;
}

/** "$0.30 in / $2.50 out per M tokens" (or "Free"). */
export function formatModelPrice(model: Pick<ModelInfo, 'promptPricePerM' | 'completionPricePerM' | 'isFree'>): string {
  if (model.isFree) return 'Free';
  return `${formatPricePerM(model.promptPricePerM)} in / ${formatPricePerM(model.completionPricePerM)} out per M tokens`;
}

/** Money spent / remaining, e.g. "$0.42" or "<$0.01". */
export function formatUsd(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '-';
  if (amount === 0) return '$0.00';
  if (Math.abs(amount) < 0.01) return '<$0.01';
  return `$${amount.toFixed(2)}`;
}
