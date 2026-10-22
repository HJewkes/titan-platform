import { describe, expect, it } from "vitest";
import { RATE_SAMPLE_MS, rateRecord, ratePeaks, runRateSampler, type RateRecord } from "./rate-sample.js";

const R1 = 1_790_000_000;
const R2 = R1 + 3600;
const AT = new Date("2026-10-22T10:00:00.000Z");

function rateLimitBody(core: number, graphql: number, reset = R1): string {
  const bucket = (used: number) => ({ limit: 5000, used, remaining: 5000 - used, reset });
  return JSON.stringify({ resources: { core: bucket(core), graphql: bucket(graphql), search: bucket(0) }, rate: bucket(core) });
}

function record(core: number, reset: number, graphql = 0): RateRecord {
  return rateRecord(JSON.parse(rateLimitBody(core, graphql, reset)), AT);
}

function sampler(answers: Array<string | Error>) {
  const appended: string[] = [];
  const warnings: string[] = [];
  const waits: number[] = [];
  const deps = {
    gh: async () => {
      const answer = answers.shift()!;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    append: (line: string) => appended.push(line),
    warn: (message: string) => warnings.push(message),
    now: () => AT,
    wait: async (ms: number) => void waits.push(ms),
    rounds: answers.length,
  };
  return { deps, appended, warnings, waits };
}

describe("rateRecord", () => {
  it("keeps used, limit and reset of core and graphql only", () => {
    expect(record(120, R1, 30)).toEqual({ at: AT.toISOString(), core: { used: 120, limit: 5000, reset: R1 }, graphql: { used: 30, limit: 5000, reset: R1 } });
  });

  it("refuses an answer missing a bucket", () => {
    expect(() => rateRecord({ resources: { core: { used: 1, limit: 5000, reset: R1 } } }, AT)).toThrow("no graphql bucket");
  });
});

describe("ratePeaks", () => {
  it("reports each window's max used before its reset, not the last sample in it", () => {
    const peaks = ratePeaks([record(900, R1, 10), record(2400, R1, 20), record(2100, R1, 15), record(50, R2, 1)]);

    expect(peaks.filter((peak) => peak.resource === "core")).toEqual([
      { resource: "core", used: 2400, limit: 5000, reset: R1 },
      { resource: "core", used: 50, limit: 5000, reset: R2 },
    ]);
    expect(peaks.find((peak) => peak.resource === "graphql" && peak.reset === R1)?.used).toBe(20);
  });
});

describe("runRateSampler", () => {
  it("appends one JSONL record per gh call, a minute apart", async () => {
    const { deps, appended, waits } = sampler([rateLimitBody(10, 1), rateLimitBody(20, 2)]);

    await runRateSampler(deps);

    expect(appended.map((line) => JSON.parse(line).core.used)).toEqual([10, 20]);
    expect(appended.every((line) => line.endsWith("}\n"))).toBe(true);
    expect(waits).toEqual([RATE_SAMPLE_MS]);
  });

  it("skips a failed or malformed call with a warning and keeps sampling", async () => {
    const { deps, appended, warnings } = sampler([new Error("gh: exit 1"), "not json", rateLimitBody(30, 3)]);

    await runRateSampler(deps);

    expect(appended.map((line) => JSON.parse(line).core.used)).toEqual([30]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("gh: exit 1");
  });
});
