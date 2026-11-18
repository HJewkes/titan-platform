import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEvalCli } from "./eval-cli.js";
import type { JudgeCall, JudgeHarness, JudgeReply } from "./eval-harness.js";
import { WRITING_METRICS } from "./lint-writing.js";
import { parseWritingCheck, WRITING_BUCKETS } from "./writing-calibrate.js";
import { useReportOnlyGate } from "./writing-gate-fixtures.test-helpers.js";

// Only the judged rows can fail here: the calibrated and deterministic gate rows are all report-only.
useReportOnlyGate();

const CLEAN_LINE = "The parser reads each record and hands it to the queue for the next worker.";
const CANARY_LINE = "That is called the derailleur.";

function reportOnlyTable(): string {
  const table = parseWritingCheck(readFileSync(new URL("../doctrine/writing-check.json", import.meta.url), "utf8"));
  for (const metric of WRITING_METRICS) for (const { name } of WRITING_BUCKETS) table.statusByBucket[metric][name] = "report-only";
  return JSON.stringify(table);
}

/** A harness that marks the canary or not, and extracts two terms the script says; it records every prompt. */
function fakeHarness(marksCanary: boolean, prompts: string[]): () => JudgeHarness {
  const answer = (prompt: string): unknown =>
    prompt.includes("Index the technical terms")
      ? { terms: ["parser", "queue"].map((term) => ({ term, first_mention: CLEAN_LINE, definition: null, motivation: null, used_after: true })) }
      : { marks: marksCanary ? [{ id: "naming_refrain", quote: CANARY_LINE, why: "a refrain" }] : [] };
  return () =>
    async <T,>({ prompt, schema }: JudgeCall<T>): Promise<JudgeReply<T>> => {
      prompts.push(prompt);
      return { ok: true, output: schema.parse(answer(prompt)), usd: 0.05, tokensIn: 100, tokensOut: 20 };
    };
}

describe("explainer eval writing --judge", () => {
  let dir: string;
  let printed: string[];
  let prompts: string[];
  const write = (name: string, value: string): string => {
    const path = join(dir, name);
    writeFileSync(path, value);
    return path;
  };
  const run = (marksCanary: boolean, ...extra: string[]) => {
    const args = ["eval", "writing", write("script.txt", Array.from({ length: 16 }, () => CLEAN_LINE).join("\n")), "--format", "text", "--json"];
    const files = ["--table", write("table.json", reportOnlyTable()), "--judge", write("judge.json", JSON.stringify({ provider: "claude-print", model: "judge-model" }))];
    return runEvalCli([...args, ...files, ...extra], { harness: fakeHarness(marksCanary, prompts) });
  };
  const report = (): unknown => JSON.parse(printed.join("\n"));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "writing-judge-"));
    printed = [];
    prompts = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void printed.push(line));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("passes a trusted run with the judged rows in the report and its spend", async () => {
    expect(await run(true)).toBe(0);
    expect(report()).toMatchObject({
      judged: { trusted: true, spend: { usd: 0.1 } },
      gate: expect.arrayContaining([
        expect.objectContaining({ id: "writing:hallmark-marks", pass: true }),
        expect.objectContaining({ id: "writing:words-per-term", pass: true }),
      ]),
    });
  });

  it("exits 1 when the canary goes unmarked: the hallmark gate is unmeasured and words per term warns", async () => {
    expect(await run(false)).toBe(1);
    expect(report()).toMatchObject({ judged: { trusted: false }, verdict: { gateFails: 1, gatesUnmeasured: 1, warnings: 1 } });
  });

  it("refuses --bench with --judge before any model call", async () => {
    expect(await run(true, "--bench", join(dir, "bench"), "--config", "c")).toBe(2);
    expect(prompts).toEqual([]);
  });
});
