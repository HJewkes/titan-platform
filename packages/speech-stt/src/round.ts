/**
 * Python's `round(x, digits)`: round half to even on the exact binary value. `toFixed` breaks
 * exact ties upward, so `roundHalfEven(0.0625, 3)` would give 0.063 where Python gives 0.062.
 * `digits` is a whole number from 0 to 20.
 */
export function roundHalfEven(x: number, digits: number): number {
  const exact = Math.abs(x).toFixed(100);
  const point = exact.indexOf(".");
  const isTie = /^50*$/.test(exact.slice(point + 1 + digits));
  if (!isTie) return Number(x.toFixed(digits));
  const scaled = Number(exact.slice(0, point) + exact.slice(point + 1, point + 1 + digits));
  const even = scaled % 2 === 0 ? scaled : scaled + 1;
  return (Math.sign(x) * even) / 10 ** digits;
}

/** Python's `round(x, 3)`. */
export function roundMillis(x: number): number {
  return roundHalfEven(x, 3);
}
