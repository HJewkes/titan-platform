export function assertProbability(name: string, value: number): void {
  if (!(value > 0 && value < 1)) throw new RangeError(`${name} must be strictly between 0 and 1, got ${value}`);
}

export function assertCount(name: string, value: number, minimum = 0): void {
  if (!Number.isInteger(value) || value < minimum) throw new RangeError(`${name} must be an integer of at least ${minimum}, got ${value}`);
}

export function assertRate(successes: number, trials: number): void {
  assertCount("trials", trials, 1);
  assertCount("successes", successes);
  if (successes > trials) throw new RangeError(`successes (${successes}) exceeds trials (${trials})`);
}
