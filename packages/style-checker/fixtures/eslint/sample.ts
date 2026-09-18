const MAX_ITEMS = 3;

export function sumFirst(values: number[]): number {
  let total = 0;
  for (const value of values.slice(0, MAX_ITEMS)) {
    total += value;
  }
  return total;
}
