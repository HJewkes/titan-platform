import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { agreement, planBatches, readItemRows, runBatch, secondJudged, TIE, UNJUDGED, type BatchPlan, type JudgeControl, type JudgeItem } from "./batch.js";
import type { JudgeFn, JudgeQuestion, JudgeSpec } from "./core.js";

const JUDGE: JudgeSpec = { model: "judge-one", effort: "high" };
const SECOND: JudgeSpec = { model: "judge-two", effort: "medium" };
const SWAP = { A: "B", B: "A" } as const;

const question = (truth: string, relabel?: Record<string, string>): JudgeQuestion => ({
  instructions: "Judge the subject.",
  criteria: [{ id: "overall", ask: "Which is better?" }],
  labels: ["A", "B", "tie", "real", "not-real"],
  decisive: "overall",
  texts: { subject: `the truth is ${truth} here` },
  ...(relabel && { relabel }),
});

const item = (key: string, ...truths: string[]): JudgeItem => ({ key, questions: truths.map((truth, order) => question(truth, order === 1 ? SWAP : undefined)) });
const control = (key: string, expected: string): JudgeControl => ({ key: `control-${key}`, questions: [question(`control-${expected}`)], expected });

type Answer = (truth: string) => string;

/** Answers with the truth the subject states, quoting it, unless a rule rewrites the verdict. */
function fakeJudge(answer: Answer = (truth) => truth.replace(/^control-/, "")) {
  const calls: { spec: JudgeSpec; truth: string }[] = [];
  let inflight = 0;
  let peak = 0;
  const judge: JudgeFn = async (spec, request) => {
    inflight++;
    peak = Math.max(peak, inflight);
    await new Promise((wake) => setTimeout(wake, 1));
    inflight--;
    const truth = /the truth is (\S+) here/.exec(request.prompt)?.[1] ?? "";
    calls.push({ spec, truth });
    const criteria = [{ id: "overall", verdict: answer(truth), cites: "subject", evidence: `the truth is ${truth}` }];
    return { ok: true, answer: { criteria }, costUsd: 0.01, sessionId: `s${calls.length}`, effortSeen: [spec.effort] };
  };
  return { judge, calls, peak: () => peak };
}

let dir: string;
let ledgerPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "judge-batch-"));
  ledgerPath = join(dir, "judgments.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const plan = (items: JudgeItem[], pool: JudgeControl[] = [control("a", "real"), control("b", "not-real")]): BatchPlan => ({
  id: "batch-1",
  track: "r-fa",
  judge: JUDGE,
  second: SECOND,
  items,
  controlPool: pool,
  controlCount: 2,
});

const Row = z.record(z.string(), z.unknown());
const rows = () => readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => Row.parse(JSON.parse(line)));

describe("runBatch controls", () => {
  it("passes a batch whose controls all score correct, on the first attempt", async () => {
    const fake = fakeJudge();
    const result = await runBatch(plan([item("i1", "real"), item("i2", "not-real")]), { judge: fake.judge, ledgerPath });
    expect(result.outcome).toBe("passed");
    expect(result.items.map((entry) => entry.outcome)).toEqual(["real", "not-real"]);
    expect(rows().filter((row) => row.kind === "batch")).toEqual([expect.objectContaining({ outcome: "passed", attempts: [expect.objectContaining({ seed: "batch-1", passed: true })] })]);
  });

  it("re-runs a batch with a failed control once under a new seed, and passes when the rerun's controls are right", async () => {
    let controlCalls = 0;
    const fake = fakeJudge((truth) => (truth.startsWith("control-") && ++controlCalls === 1 ? "A" : truth.replace(/^control-/, "")));
    const result = await runBatch(plan([item("i1", "real")]), { judge: fake.judge, ledgerPath });
    expect(result.outcome).toBe("passed");
    const batch = rows().find((row) => row.kind === "batch");
    expect(batch?.attempts).toEqual([expect.objectContaining({ seed: "batch-1", passed: false }), expect.objectContaining({ seed: "batch-1:rerun", passed: true })]);
  });

  it("voids a batch whose controls fail twice and reports its items unjudged", async () => {
    const fake = fakeJudge((truth) => (truth === "control-real" ? "not-real" : truth.replace(/^control-/, "")));
    const result = await runBatch(plan([item("i1", "real"), item("i2", "real")]), { judge: fake.judge, ledgerPath });
    expect(result.outcome).toBe("void");
    expect(result.items.map((entry) => entry.outcome)).toEqual([UNJUDGED, UNJUDGED]);
    expect(fake.calls.filter((call) => call.truth === "control-real")).toHaveLength(2);
    expect(readItemRows(ledgerPath).map((row) => row.outcome)).toEqual([UNJUDGED, UNJUDGED]);
  });

  it("records every call, including controls, with the judge's cost", async () => {
    const fake = fakeJudge();
    await runBatch(plan([item("i1", "real")]), { judge: fake.judge, ledgerPath });
    const calls = rows().filter((row) => row.kind === "call" && row.role !== "second");
    expect(calls.map((row) => row.role).sort()).toEqual(["control", "control", "item"]);
    expect(calls.every((row) => row.costUsd === 0.01)).toBe(true);
  });
});

describe("runBatch pairwise orders", () => {
  it("counts a verdict when both presentation orders agree", async () => {
    const result = await runBatch(plan([item("p1", "A", "B")], [control("c", "A")]), { judge: fakeJudge().judge, ledgerPath });
    expect(result.items.map((entry) => entry.outcome)).toEqual(["A"]);
  });

  it("scores disagreeing orders as a tie, never as the first order's verdict", async () => {
    const result = await runBatch(plan([item("p1", "A", "A")], [control("c", "A")]), { judge: fakeJudge().judge, ledgerPath });
    expect(result.items.map((entry) => entry.outcome)).toEqual([TIE]);
  });
});

describe("runBatch limits and second judge", () => {
  it("keeps at most four judge calls in flight", async () => {
    const fake = fakeJudge();
    const items = Array.from({ length: 10 }, (_, index) => item(`i${index}`, "A", "B"));
    await runBatch(plan(items, [control("c", "A")]), { judge: fake.judge, ledgerPath });
    expect(fake.peak()).toBe(4);
  });

  it("sends the seeded items, and only those, to the second judge", async () => {
    const items = Array.from({ length: 10 }, (_, index) => item(`i${index}`, "real"));
    const chosen = secondJudged("batch-1", items.map((entry) => entry.key));
    const fake = fakeJudge();
    const result = await runBatch(plan(items), { judge: fake.judge, ledgerPath });
    expect(fake.calls.filter((call) => call.spec === SECOND)).toHaveLength(chosen.size);
    expect(result.items.filter((entry) => entry.second !== undefined).map((entry) => entry.key)).toEqual([...chosen]);
  });

  it("picks about a fifth of items for the second judge, fixed by the batch id", () => {
    const keys = Array.from({ length: 1000 }, (_, index) => `k${index}`);
    const chosen = secondJudged("batch-x", keys);
    expect(chosen.size).toBeGreaterThan(150);
    expect(chosen.size).toBeLessThan(250);
    expect(secondJudged("batch-x", keys)).toEqual(chosen);
  });
});

describe("planBatches", () => {
  it("cuts each judge pair's items into batches of at most ten", () => {
    const other = { judge: SECOND, second: JUDGE };
    const planned = Array.from({ length: 23 }, (_, index) => ({ item: item(`i${index}`, "real"), judges: index < 21 ? { judge: JUDGE, second: SECOND } : other }));
    const plans = planBatches("r-fa", planned, [], 1);
    expect(plans.map((entry) => [entry.judge.model, entry.items.length])).toEqual([["judge-one", 10], ["judge-one", 10], ["judge-one", 1], ["judge-two", 2]]);
    expect(new Set(plans.map((entry) => entry.id)).size).toBe(4);
  });
});

describe("agreement", () => {
  it("computes raw agreement and Cohen's kappa over three-way labels", () => {
    const pairs = [["A", "A"], ["A", "A"], ["B", "B"], ["B", "tie"], ["tie", "tie"], ["A", "B"]] as const;
    const result = agreement(pairs);
    expect(result.raw).toBeCloseTo(4 / 6);
    expect(result.kappa).toBeCloseTo((4 / 6 - 1 / 3) / (1 - 1 / 3));
  });

  it("reports no kappa when every answer is the same label", () => {
    expect(agreement([["real", "real"], ["real", "real"]])).toEqual({ n: 2, raw: 1, kappa: null });
  });
});
