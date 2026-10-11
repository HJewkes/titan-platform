/**
 * Builds a `T` for a test from only the fields the code under test reads. A field left out is
 * `undefined` at run time even though `T` says it exists, which is the point when a test probes
 * missing input and a trap otherwise: fake every field the code under test touches.
 */
declare function partialFake<T extends object>(fields?: Partial<T>): T;

export { partialFake };
