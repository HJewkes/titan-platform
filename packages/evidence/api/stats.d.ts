interface Interval {
    estimate: number;
    lower: number;
    upper: number;
}
/** Shape parameters of a Beta prior on a pass rate. */
interface BetaPrior {
    alpha: number;
    beta: number;
}
/** The Wilson score interval for successes out of trials; estimate is the observed rate. */
declare function wilson(successes: number, trials: number, options?: {
    confidence?: number;
}): Interval;
/**
 * The equal-tailed credible interval of the Beta posterior for a pass rate.
 * The default Jeffreys prior Beta(0.5, 0.5) gives good frequentist coverage at small n.
 */
declare function betaBinomialInterval(successes: number, trials: number, options?: {
    confidence?: number;
    prior?: BetaPrior;
}): Interval;

interface AucIntervalOptions {
    /** One cluster key per score, for each group. Scores sharing a key are resampled together. */
    clusters?: {
        pos: readonly string[];
        neg: readonly string[];
    };
    /** Number of resamples; defaults to 10000. */
    resamples?: number;
    /** Seed for `seededRandom`; defaults to 0, so an unseeded call is still reproducible. */
    seed?: string | number;
    confidence?: number;
}
/**
 * The probability a random positive score outranks a random negative one (Mann-Whitney U over n*m).
 * A tied pair counts one half.
 */
declare function rocAuc(pos: readonly number[], neg: readonly number[]): number;
/**
 * A percentile bootstrap interval for `rocAuc`. The two groups are resampled separately (stratified),
 * and by cluster when keys are given, so correlated texts are not counted as independent.
 */
declare function aucInterval(pos: readonly number[], neg: readonly number[], options?: AucIntervalOptions): Interval;

interface BootstrapOptions {
    confidence?: number;
    /** Number of resamples; defaults to 10000. */
    resamples?: number;
    /** Seed for `seededRandom`; defaults to 0, so an unseeded call is still reproducible. */
    seed?: string | number;
    /** The statistic computed on each resample; defaults to the mean. */
    statistic?: (sample: readonly number[]) => number;
}
/**
 * A percentile bootstrap interval for a statistic of one sample.
 * Pass one value per case (for example a case's pass rate over its trials), so resampling is by case.
 */
declare function bootstrapCI(values: readonly number[], options?: BootstrapOptions): Interval;
/** A percentile bootstrap interval for mean(a[i] - b[i]), resampling cases so each pair stays together. */
declare function pairedBootstrap(a: readonly number[], b: readonly number[], options?: Omit<BootstrapOptions, "statistic">): Interval;

type McNemarMethod = "exact" | "chi-square";
interface McNemarResult {
    method: McNemarMethod;
    /** min(onlyA, onlyB) for the exact test; the corrected chi-square value otherwise. */
    statistic: number;
    pValue: number;
}
/**
 * Two-sided McNemar test on the discordant pairs of a paired binary comparison.
 * onlyA counts cases arm A passed and arm B failed; onlyB the reverse.
 * "auto" (the default) runs the exact binomial test below 25 discordant pairs and the
 * continuity-corrected chi-square from 25, where the two agree closely.
 * The chi-square correction is floored at zero, so a tie gives p = 1.
 */
declare function mcnemar(onlyA: number, onlyB: number, options?: {
    method?: McNemarMethod | "auto";
}): McNemarResult;

interface DetectableEffectOptions {
    /** Number of paired cases. */
    n: number;
    /** Standard deviation of the per-case difference; 0.5 is the largest a single pass/fail rate can have, but a paired binary difference can reach 1. */
    sd: number;
    /** Significance level; defaults to 0.05. */
    alpha?: number;
    /** Probability of detecting the effect; defaults to 0.8. */
    power?: number;
    /** 2 (default) for a two-sided test, 1 for one-sided. */
    sides?: 1 | 2;
}
/**
 * The smallest mean paired difference a z-test on n cases detects at the given alpha and power:
 * sd * (z(1 - alpha / sides) + z(power)) / sqrt(n). Defaults: two-sided, alpha 0.05, power 0.8.
 * A planning figure under the normal approximation, so it is optimistic below about 30 cases.
 */
declare function minimumDetectableEffect(options: DetectableEffectOptions): number;

export { type AucIntervalOptions, type BetaPrior, type BootstrapOptions, type DetectableEffectOptions, type Interval, type McNemarMethod, type McNemarResult, aucInterval, betaBinomialInterval, bootstrapCI, mcnemar, minimumDetectableEffect, pairedBootstrap, rocAuc, wilson };
