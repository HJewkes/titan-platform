/**
 * A method to count, as `[prototype or object, key]`: `[Array.prototype, "push"]`, `[Map.prototype, "get"]`, or
 * `[Array.prototype, Symbol.iterator]`, which every `for...of` over an array calls once.
 */
type CountedMethod = readonly [object, PropertyKey];
interface CallMeter {
    /** The calls made to the methods since the meter was installed; a running total, as `linearWork`'s `meter` takes. */
    readonly calls: () => number;
    /** Puts the original methods back. */
    readonly restore: () => void;
}
/**
 * Counts every call to `methods` until `restore`. Calls are the same on every machine and under any load, so a test can
 * assert work flat or linear in its input where a millisecond limit would flake (TP-4262). Every call past `cap` throws,
 * so a quadratic walk stops there instead of running to its end.
 */
declare function callMeter(methods: readonly CountedMethod[], cap?: number): CallMeter;
/**
 * The calls `run` makes to `methods`. Past `cap` the count it returns is above `cap` for the test to fail on, even when
 * the code under test caught the throw. Synchronous only: an async `run` would count whatever else ran while it waited.
 */
declare function countCalls(methods: readonly CountedMethod[], run: () => unknown, cap?: number): number;

interface HostileGlob {
    readonly name: string;
    readonly glob: string;
    /** A path of about `size` segments or characters that the glob does not match, so a backtracking matcher tries every split. */
    readonly path: (size: number) => string;
    /** The size from which every state of a linear matcher is live, so its work per character stops growing; `linearWork`'s `steady`. */
    readonly steady: number;
}
/**
 * The hostile rows of tp#2491 (TP-1756): `d/` and twenty `*` took 64 s on a 40-character path under the RegExp glob
 * compiler, and twelve `**\/` grow the same way. `separator` replaces `/` for a dialect that reads it as a literal or
 * refuses it, such as a round-id glob or a command word. Each row is `[name, row]`, for `it.each` with `%s`.
 */
declare function hostileGlobs(separator?: string): (readonly [string, HostileGlob])[];

/** How much larger each rung of the ladder is than the one before. */
declare const GROWTH = 4;
/**
 * The largest ratio a linear operation may show. A run at a size GROWTH times larger is counted against GROWTH runs at
 * the smaller size: at most the same work when linear (a ratio near 1, or below it where a fixed cost dominates), GROWTH
 * times more when quadratic, far more for a backtracking matcher. Counts are the same on every machine and under any
 * load, so the limit needs no room for noise.
 */
declare const LINEAR_WORK_LIMIT = 2;
interface WorkOptions {
    /** The first size; each rung multiplies it by GROWTH until it would pass `to`. */
    from: number;
    /** The largest size counted when every rung below it stays under the limit. */
    to: number;
    /** A running total of the work done so far, such as fix-proof's `linearRegExpSteps`; read before and after each run. */
    meter: () => number;
    /**
     * The smallest size whose rung is judged on its ratio; smaller rungs must only be counted. A pattern of m states can
     * hold more of them live with each character until the input is about m long, which reads as growth below that size.
     * Defaults to `from`.
     */
    steady?: number;
}
interface WorkGrowth {
    /** The worst ratio seen; at or past LINEAR_WORK_LIMIT the ladder stopped there. Infinity when the meter saw no work. */
    ratio: number;
    /** The larger size of the rung that gave `ratio`. */
    size: number;
}
/**
 * Climbs sizes `from`, `from * GROWTH`, ... up to `to`, and at each rung compares the work `meter` counts for one run of
 * the larger size with GROWTH runs of the smaller. It stops at the first rung whose ratio reaches LINEAR_WORK_LIMIT,
 * before trying a larger size, so a polynomial walk fails on a small input instead of hanging on the large one. A run
 * the meter counts nothing for gives Infinity at once: the operation no longer goes through the counted engine, as when
 * a matcher falls back to a backtracking RegExp. Assert `ratio` below LINEAR_WORK_LIMIT in the test (TP-4262).
 */
declare function linearWork(prepare: (size: number) => () => void, options: WorkOptions): WorkGrowth;

/**
 * Builds a `T` for a test from only the fields the code under test reads. A field left out is
 * `undefined` at run time even though `T` says it exists, which is the point when a test probes
 * missing input and a trap otherwise: fake every field the code under test touches.
 */
declare function partialFake<T extends object>(fields?: Partial<T>): T;

export { type CallMeter, type CountedMethod, GROWTH, type HostileGlob, LINEAR_WORK_LIMIT, type WorkGrowth, type WorkOptions, callMeter, countCalls, hostileGlobs, linearWork, partialFake };
