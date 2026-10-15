/**
 * Python's `round(x, 3)`: round half to even on the exact binary value. `toFixed` breaks
 * exact ties upward, so 0.0625 would give 0.063 where Python gives 0.062.
 */
export function roundMillis(x: number): number {
  const exact = Math.abs(x).toFixed(100);
  const point = exact.indexOf(".");
  const isTie = /^50*$/.test(exact.slice(point + 4));
  if (!isTie) return Number(x.toFixed(3));
  const thousandths = Number(exact.slice(0, point) + exact.slice(point + 1, point + 4));
  const even = thousandths % 2 === 0 ? thousandths : thousandths + 1;
  return (Math.sign(x) * even) / 1000;
}
