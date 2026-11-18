/**
 * Levenshtein distance over code points, after NFC normalisation, computed only
 * within `maxDistance` of the diagonal. Returns the exact distance when it is at
 * most `maxDistance`, and `maxDistance + 1` otherwise, stopping as soon as every
 * cell of a row passes the band.
 */
export function editDistance(a: string, b: string, maxDistance = Number.POSITIVE_INFINITY): number {
  const source = Array.from(a.normalize("NFC"));
  const target = Array.from(b.normalize("NFC"));
  const over = maxDistance + 1;
  if (Math.abs(source.length - target.length) > maxDistance) return over;
  let previous = target.map((_, j) => (j + 1 <= maxDistance ? j + 1 : over));
  previous.unshift(0);
  for (let i = 1; i <= source.length; i++) {
    const current = bandedRow(source[i - 1], target, previous, i, maxDistance);
    if (Number.isFinite(maxDistance) && current.every((cell) => cell > maxDistance)) return over;
    previous = current;
  }
  return previous[target.length] ?? over;
}

function bandedRow(char: string | undefined, target: string[], previous: number[], i: number, maxDistance: number): number[] {
  const over = maxDistance + 1;
  const current = new Array<number>(target.length + 1).fill(over);
  current[0] = i <= maxDistance ? i : over;
  const from = Math.max(1, i - maxDistance);
  const to = Math.min(target.length, i + maxDistance);
  for (let j = from; j <= to; j++) {
    const cost = char === target[j - 1] ? 0 : 1;
    const deletion = (previous[j] ?? over) + 1;
    const insertion = (current[j - 1] ?? over) + 1;
    const substitution = (previous[j - 1] ?? over) + cost;
    current[j] = Math.min(deletion, insertion, substitution, over);
  }
  return current;
}

/** The distance a term of this length may be corrected across: 1 up to 4 characters, 2 up to 12, 3 beyond. */
export function maxEditDistance(termLength: number): number {
  if (termLength <= 4) return 1;
  if (termLength <= 12) return 2;
  return 3;
}
