/**
 * Builds a `T` for a test from only the fields the code under test reads. A field left out is
 * `undefined` at run time even though `T` says it exists, which is the point when a test probes
 * missing input and a trap otherwise: fake every field the code under test touches.
 */
export function partialFake<T extends object>(fields?: Partial<T>): T;
// The overload is the helper's one unchecked step, kept here so test files need no `as unknown as T`.
export function partialFake(fields: object = {}): object {
  return fields;
}
