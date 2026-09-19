/** Shared physical-value palette for the table and both surface views. */
export function heatColor(value: number, min: number, max: number): string {
  if (![value, min, max].every(Number.isFinite)) return 'transparent';
  const t = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0.5;
  return `hsl(${220 - 55 * t}, 55%, ${22 + 8 * t}%)`;
}
