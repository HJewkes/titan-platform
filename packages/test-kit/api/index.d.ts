interface HostileGlob {
    readonly name: string;
    readonly glob: string;
    /** A path of about `size` segments or characters that the glob does not match, so a backtracking matcher tries every split. */
    readonly path: (size: number) => string;
}
/**
 * The timing rows of tp#2491 (TP-1756): `d/` and twenty `*` took 64 s on a 40-character path under the RegExp glob
 * compiler, and twelve `**\/` grow the same way. `separator` replaces `/` for a dialect that reads it as a literal or
 * refuses it, such as a round-id glob or a command word. Each row is `[name, row]`, for `it.each` with `%s`.
 */
declare function hostileGlobs(separator?: string): (readonly [string, HostileGlob])[];

/** How much larger each rung of the ladder is than the one before. */
declare const GROWTH = 4;
/**
 * The largest ratio a linear operation should show. One run at a size GROWTH times larger is timed against GROWTH runs
 * at the smaller size: the same work when linear (a ratio near 1), GROWTH times more when quadratic, far more for the
 * polynomial backtracking of a RegExp glob.
 */
declare const LINEAR_GROWTH_LIMIT = 2.5;
interface GrowthOptions {
    /** The first size; each rung multiplies it by GROWTH until it would pass `to`. */
    from: number;
    /** The largest size measured when every rung below it stays under the limit. */
    to: number;
    /** Starts a stopwatch; calling the result gives the milliseconds since. Defaults to this thread's CPU time. */
    stopwatch?: () => () => number;
    /** Runs between timed batches, for a caller that checks a CPU budget there. */
    between?: () => void;
}
interface Growth {
    /** The worst ratio seen; at or past LINEAR_GROWTH_LIMIT the ladder stopped there. */
    ratio: number;
    /** The larger size of the rung that gave `ratio`. */
    size: number;
}
/**
 * Climbs sizes `from`, `from * GROWTH`, ... up to `to`, and at each rung compares one run of the larger size with GROWTH
 * runs of the smaller (best of seven, interleaved, so lasting contention slows both sides alike). It stops at the first
 * rung whose ratio reaches LINEAR_GROWTH_LIMIT, before trying a larger size, so a polynomial matcher fails on a small
 * input in milliseconds instead of hanging on the large one. Assert `ratio` below LINEAR_GROWTH_LIMIT in the test.
 */
declare function linearGrowth(prepare: (size: number) => () => void, options: GrowthOptions): Growth;

/**
 * Builds a `T` for a test from only the fields the code under test reads. A field left out is
 * `undefined` at run time even though `T` says it exists, which is the point when a test probes
 * missing input and a trap otherwise: fake every field the code under test touches.
 */
declare function partialFake<T extends object>(fields?: Partial<T>): T;

export { GROWTH, type Growth, type GrowthOptions, type HostileGlob, LINEAR_GROWTH_LIMIT, hostileGlobs, linearGrowth, partialFake };
