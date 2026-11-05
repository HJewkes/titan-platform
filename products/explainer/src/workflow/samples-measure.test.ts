import { describe, expect, it } from "vitest";
import type { TargetRow } from "../rewrite-pass.js";
import { choppy } from "../rewrite-fixtures.test-helpers.js";
import { NO_USAGE, type StageRecord } from "./records.js";
import { ChildStageFailure } from "./stage-cache.js";
import { runSamples, sampleRange, targetRowsOf, type SampleEnv } from "./samples-measure.js";

const record = (outputs: Record<string, string>, usd = 0.5): StageRecord => ({
  stage: "script", bridged: false, startedAt: "t", endedAt: "t", wallMs: 1, usage: { ...NO_USAGE, usd, calls: 1 }, retries: 0, outputs, checks: [], notes: [],
});
const numbers = (value: number): TargetRow[] => [{ check_id: "register:numbers", value, threshold: 25, pass: value <= 25 }];

/** A fake stage whose draft sha names its numbers value, so scoring reads the value back. */
function env(runFor: (inputs: Readonly<Record<string, string>>, sample: number) => Promise<StageRecord>): SampleEnv & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run: (inputs, sample) => {
      calls.push(`${inputs.spine}#${sample}`);
      return runFor(inputs, sample);
    },
    score: (sha) => numbers(Number(sha.replace(/^\D+/, ""))),
  };
}

const cases = [{ name: "a", inputs: { spine: "sa", facts: "fa" } }, { name: "b", inputs: { spine: "sb", facts: "fb" } }];

describe("runSamples", () => {
  it("runs every sample index over every case, sample-major, and collects each draft's rows", async () => {
    const fake = env(async (inputs, sample) => record({ draft: `d${inputs.spine === "sa" ? 20 + sample : 30 + sample}` }));

    const result = await runSamples({ stage: "script", cases, samples: [3, 4] }, fake);

    expect(fake.calls).toEqual(["sa#3", "sb#3", "sa#4", "sb#4"]);
    expect(result.inputs).toEqual([{ name: "a", samples: [numbers(23), numbers(24)] }, { name: "b", samples: [numbers(33), numbers(34)] }]);
    expect(result.spentUsd).toBe(2);
  });

  it("scores rewrite's input draft as the before", async () => {
    const fake = env(async () => ({ ...record({ script: "s20" }), stage: "rewrite" }));

    const result = await runSamples({ stage: "rewrite", cases: [{ name: "a", inputs: { draft: "d40" } }], samples: [0] }, fake);

    expect(result.inputs[0]).toEqual({ name: "a", before: numbers(40), samples: [numbers(20)] });
  });

  it("refuses a rewrite case with no draft input before any run", async () => {
    const fake = env(async () => record({ script: "s20" }));

    await expect(runSamples({ stage: "rewrite", cases, samples: [0] }, fake)).rejects.toThrow('case a has no "draft" input');
    expect(fake.calls).toEqual([]);
  });

  it("counts a sample whose stage failed a gate but made its draft, and its spend", async () => {
    const fake = env(async () => {
      throw new ChildStageFailure("gate l0 failed", record({ draft: "d27" }, 0.4));
    });

    const result = await runSamples({ stage: "script", cases: cases.slice(0, 1), samples: [0] }, fake);

    expect(result.inputs[0]!.samples).toEqual([numbers(27)]);
    expect(result.runs).toEqual([{ case: "a", sample: 0, usd: 0.4, cached: false, gateFailed: true }]);
  });

  it("leaves out a sample that made no draft and records why", async () => {
    const fake = env(async () => {
      throw new Error("claude-print exited 1");
    });

    const result = await runSamples({ stage: "script", cases: cases.slice(0, 1), samples: [0] }, fake);

    expect(result.inputs[0]!.samples).toEqual([]);
    expect(result.runs[0]).toMatchObject({ usd: 0, error: "claude-print exited 1" });
  });

  it("stops before a run the dearest run so far says would pass the cap", async () => {
    const fake = env(async () => record({ draft: "d20" }, 1));

    const result = await runSamples({ stage: "script", cases, samples: [0, 1], maxUsd: 2.5 }, fake);

    expect(fake.calls).toEqual(["sa#0", "sb#0"]);
    expect(result.stopped).toBe("spend cap: $2.0000 spent, the next run (est. $1.0000) would pass $2.5");
  });

  it("counts an earlier pass's runs toward the cap and the next-run estimate", async () => {
    const fake = env(async () => record({ draft: "d20" }, 0.1));
    const prior = [{ case: "a", sample: 0, usd: 2, cached: false }];

    const result = await runSamples({ stage: "script", cases, samples: [1], maxUsd: 3, prior }, fake);

    expect(fake.calls).toEqual([]);
    expect(result.stopped).toBe("spend cap: $2.0000 spent, the next run (est. $2.0000) would pass $3");
  });

  it("runs on to exactly the cap", async () => {
    const fake = env(async () => record({ draft: "d20" }, 1));

    expect((await runSamples({ stage: "script", cases, samples: [0, 1], maxUsd: 4 }, fake)).stopped).toBeUndefined();
  });
});

describe("sampleRange and targetRowsOf", () => {
  it("numbers samples from the first index", () => {
    expect(sampleRange(3, 3)).toEqual([3, 4, 5]);
  });

  it("keeps only the five Q-V11 target rows of a script's L0 run", () => {
    const ids = targetRowsOf(JSON.stringify(choppy())).map((row) => row.check_id);

    expect(ids.sort()).toEqual(["register:numbers", "register:numbers-per-beat", "register:sentence-cv", "register:sentence-mean", "register:triads"]);
  });
});
