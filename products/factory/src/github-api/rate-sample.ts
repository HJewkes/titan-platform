import { isObjectLike } from "@titan-design/rpc-protocol/narrow";
// Imported by scripts/f11-rate-sample.mjs under Node's type stripping, which does not map `.js` specifiers to `.ts`
// files, so this module imports only types.
import type { UsageWindow } from "./usage-meter.js";

/** The sampler's interval: `gh api rate_limit` costs no rate-limit points, so a minute loses nothing. */
export const RATE_SAMPLE_MS = 60_000;

const RESOURCES = ["core", "graphql"] as const;
type Resource = (typeof RESOURCES)[number];

interface RateBucket {
  used: number;
  limit: number;
  reset: number;
}

/** One JSONL line of the HJewkes-side F11 sample. */
export type RateRecord = { at: string } & Record<Resource, RateBucket>;

/** Throws on a body without both buckets, so the sampler skips that minute rather than write half a record. */
export function rateRecord(body: unknown, at: Date): RateRecord {
  const resources = isObjectLike(body) && isObjectLike(body.resources) ? body.resources : {};
  return { at: at.toISOString(), core: bucket(resources.core, "core"), graphql: bucket(resources.graphql, "graphql") };
}

function bucket(value: unknown, name: Resource): RateBucket {
  const { used, limit, reset } = isObjectLike(value) ? value : {};
  if (!isCount(used) || !isCount(limit) || !isCount(reset)) throw new Error(`rate_limit answer has no ${name} bucket`);
  return { used, limit, reset };
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

/** The peak per reset window is the max `used` seen before that reset, whatever the last sample in it read. */
export function ratePeaks(records: readonly RateRecord[]): UsageWindow[] {
  const peaks = new Map<string, UsageWindow>();
  for (const record of records) {
    for (const resource of RESOURCES) {
      const { used, limit, reset } = record[resource];
      const key = `${resource}@${reset}`;
      if ((peaks.get(key)?.used ?? -1) < used) peaks.set(key, { resource, used, limit, reset });
    }
  }
  return [...peaks.values()];
}

interface SamplerDeps {
  /** `gh api rate_limit`'s stdout, run as the identity being measured. */
  gh(): Promise<string>;
  append(line: string): void;
  warn(message: string): void;
  now(): Date;
  wait(ms: number): Promise<void>;
  /** Unbounded when absent: the sampler runs until its process is stopped. */
  rounds?: number;
}

/** A failed call costs only its minute, so a 48 h window survives a network blip. */
export async function runRateSampler(deps: SamplerDeps): Promise<void> {
  for (let round = 0; deps.rounds === undefined || round < deps.rounds; round++) {
    if (round > 0) await deps.wait(RATE_SAMPLE_MS);
    try {
      deps.append(`${JSON.stringify(rateRecord(JSON.parse(await deps.gh()), deps.now()))}\n`);
    } catch (error) {
      deps.warn(`f11-rate-sample: skipped a sample: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
