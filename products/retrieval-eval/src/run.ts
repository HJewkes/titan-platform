import type { Candidate, SearchContext } from "./candidates/candidate.js";
import type { AggregateScore, PairScore } from "./metrics.js";
import { aggregate, scorePair } from "./metrics.js";
import type { Arm, EvalPair } from "./pairs.js";
import type { QueryVariant } from "./query/variants.js";
import { deriveQuery, documentFrequency } from "./query/variants.js";

/** Scoring the pairs. One row per (arm, candidate, query variant), which is the grid to read. */

export const DEFAULT_KS = [5, 10];
/** k at which injected characters are reported, per the task's budget question. */
export const BUDGET_K = 5;

export interface RunRow {
  arm: Arm;
  candidate: string;
  variant: QueryVariant;
  score: AggregateScore;
  /** Queries the candidate threw on, counted rather than hidden. */
  errors: number;
}

export interface RunOptions {
  pairs: EvalPair[];
  candidates: Candidate[];
  variants: QueryVariant[];
  ks?: number[];
  limit?: number;
  onProgress?: (done: number, total: number) => void;
}

export async function runEval(options: RunOptions): Promise<RunRow[]> {
  const ks = options.ks ?? DEFAULT_KS;
  const limit = options.limit ?? Math.max(...ks);
  const df = documentFrequency(options.pairs.map((pair) => pair.query));
  const rows: RunRow[] = [];
  let done = 0;
  const total = arms(options.pairs).length * options.candidates.length * options.variants.length;
  for (const arm of arms(options.pairs)) {
    const armPairs = options.pairs.filter((pair) => pair.arm === arm);
    for (const candidate of options.candidates) {
      for (const variant of options.variants) {
        rows.push(await scoreOne({ arm, armPairs, candidate, variant, df, ks, limit }));
        options.onProgress?.(++done, total);
      }
    }
  }
  return rows;
}

function arms(pairs: EvalPair[]): Arm[] {
  return [...new Set(pairs.map((pair) => pair.arm))].sort();
}

interface ScoreOneInput {
  arm: Arm;
  armPairs: EvalPair[];
  candidate: Candidate;
  variant: QueryVariant;
  df: Map<string, number>;
  ks: number[];
  limit: number;
}

async function scoreOne(input: ScoreOneInput): Promise<RunRow> {
  const scores: PairScore[] = [];
  let errors = 0;
  for (const pair of input.armPairs) {
    const query = deriveQuery(input.variant, pair.query, input.df);
    const context = { arm: pair.arm, ...(pair.provenance.initiative ? { initiative: pair.provenance.initiative } : {}) };
    const hits = await safeSearch(input.candidate, query, input.limit, context);
    if (hits === undefined) {
      errors++;
      continue;
    }
    scores.push(scorePair(hits, pair, input.ks, BUDGET_K));
  }
  return {
    arm: input.arm,
    candidate: input.candidate.name,
    variant: input.variant,
    score: aggregate(scores, input.ks),
    errors,
  };
}

/**
 * A candidate that throws on one query loses that query, not the run.
 *
 * An empty derived query is passed through rather than short-circuited. The
 * query-driven candidates answer nothing to it, which is the honest score for a
 * variant that reduced a brief to nothing; the date-order baseline answers the
 * same list it always would, which is the honest score for a mechanism that
 * never read the query in the first place.
 */
async function safeSearch(candidate: Candidate, query: string, limit: number, context: SearchContext) {
  try {
    return await candidate.search(query, limit, context);
  } catch {
    return undefined;
  }
}

export function formatRows(rows: RunRow[], ks: number[] = DEFAULT_KS): string {
  const header = ["arm", "candidate", "variant", "pairs", ...ks.flatMap((k) => [`R@${k}`, `P@${k}`]), "MRR", `chars@${BUDGET_K}`, "err"];
  const lines = [header.join("\t")];
  for (const row of rows) {
    lines.push(
      [
        row.arm,
        row.candidate,
        row.variant,
        String(row.score.pairs),
        ...ks.flatMap((k) => [fixed(row.score.recallAt[k]), fixed(row.score.precisionAt[k])]),
        fixed(row.score.mrr),
        Math.round(row.score.meanInjectedChars).toString(),
        String(row.errors),
      ].join("\t"),
    );
  }
  return lines.join("\n");
}

function fixed(value: number | undefined): string {
  return (value ?? 0).toFixed(3);
}
