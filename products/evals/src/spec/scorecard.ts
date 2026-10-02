import { z } from "zod";
import { count, fraction, nonempty, objectFor, sha256, timestamp, usd } from "./common.js";
import type { SpecParseMode } from "./common.js";
import { resolvedChampions } from "./trial.js";

export const SCORECARD_SCHEMA_VERSION = "titan.scorecard/v1";

function envFingerprint(mode: SpecParseMode) {
  return objectFor(mode)({
    claudeCodeVersion: nonempty.optional(),
    harness: z.record(nonempty, nonempty),
    os: nonempty,
    priceTable: nonempty,
  });
}

function intervals(mode: SpecParseMode) {
  const object = objectFor(mode);
  const rate = object({ successes: count, n: count, rate: fraction, lower: fraction, upper: fraction });
  const meanCI = object({ mean: z.number(), lower: z.number(), upper: z.number(), n: count });
  return { rate, meanCI };
}

function perCaseRow(mode: SpecParseMode) {
  return objectFor(mode)({
    case: sha256,
    trials: count,
    passed: count,
    errored: count,
    costUsd: usd,
  });
}

export function scorecardSchema(mode: SpecParseMode) {
  const object = objectFor(mode);
  const { rate, meanCI } = intervals(mode);
  return object({
    schema: z.literal(SCORECARD_SCHEMA_VERSION),
    keys: object({
      unit: sha256,
      variant: sha256,
      champions: resolvedChampions.optional(),
      suite: sha256,
      judges: sha256,
      env: envFingerprint(mode),
    }),
    n: object({ cases: count, trials: count, errored: count, infraErrored: count }),
    success: rate,
    passAllK: rate,
    criteria: z.record(nonempty, meanCI),
    metrics: z.record(nonempty, object({ median: z.number(), p90: z.number() })),
    costPerSuccess: usd.nullable(),
    overhead: object({ judgeUsd: usd, simOwnerUsd: usd }),
    perCase: z.array(perCaseRow(mode)),
    controls: object({ planted: count, caught: count }),
    snapshot: object({ builtAt: timestamp, split: nonempty, window: nonempty.optional() }),
  });
}
