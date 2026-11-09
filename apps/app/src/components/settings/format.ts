const groupThousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** 1234.6 -> "1,235". */
export function formatInt(n: number): string {
  const r = Math.round(n);
  return `${r < 0 ? '-' : ''}${groupThousands(Math.abs(r))}`;
}

/** 1234.6 -> "1,235 kcal". */
export function formatKcal(n: number): string {
  return `${formatInt(n)} kcal`;
}

/** Signed integer for adjustments: 356 -> "+356", -499 -> "-499", 0 -> "0". */
export function formatSigned(n: number): string {
  const r = Math.round(n);
  if (r === 0) return '0';
  return `${r > 0 ? '+' : '-'}${groupThousands(Math.abs(r))}`;
}

/** Amount with a sensible number of decimals: 123.4 -> "123", 12.34 -> "12.3", 1.234 -> "1.23". */
export function formatAmount(n: number): string {
  const abs = Math.abs(n);
  const decimals = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return String(Number(n.toFixed(decimals)));
}

/** Up to one decimal, trailing zero dropped: 30 -> "30", 33.333 -> "33.3". */
export function formatPct(n: number): string {
  return String(Number(n.toFixed(1)));
}

/** "Mar 3, 2027" for a YYYY-MM-DD string (parsed as a local date). */
export function formatShortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
