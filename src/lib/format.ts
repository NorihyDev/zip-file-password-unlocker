/** Compact large search spaces without converting exact integers to floats. */
export function formatCount(value: bigint): string {
  return new Intl.NumberFormat('en', {
    notation: value >= 1_000_000_000_000n ? 'scientific' : 'standard',
    maximumFractionDigits: 2,
  }).format(value)
}

/** Scale before converting to Number so huge totals cannot overflow. */
export function progressPercent(attempted: bigint, total: bigint): number {
  if (total <= 0n) return 0
  return Math.min(100, Number((attempted * 1_000_000n) / total) / 10_000)
}
