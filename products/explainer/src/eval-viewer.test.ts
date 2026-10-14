import { describe, expect, it } from "vitest";
import { readRubric } from "./eval-evidence.js";
import type { JudgeHarness } from "./eval-harness.js";
import { deriveEvalView } from "./eval-view.js";
import { l2EvalVersion, layoutScores, runL2, type L2Input } from "./eval-viewer.js";
import { ScriptSchema } from "./script-schema.js";
import { fakeViewer, sonnet, twoChapters } from "./judge-fakes.test-helpers.js";

const rubric = readRubric("l2-viewer.md");
const answerKey = [
  { qid: "Q1", required_terms: ["courier", "label"] },
  { qid: "Q5", required_terms: ["desk server", "ledger", "scan log"] },
];
const referenceGraph = [
  { from: "Scanner", to: "Desk server" },
  { from: "Desk server", to: "Ledger" },
];
const answers = {
  Q1: "It stops a courier printing a label for a parcel that was never scanned.",
  Q2: "Scanner -> Desk server : http\nDesk server -> Printer : queue",
  Q5: "A desk server in front of the ledger.",
};
const input = (harness: JudgeHarness): L2Input => ({
  scriptSha: "0123456789ab",
  beats: deriveEvalView(ScriptSchema.parse(twoChapters)),
  rubric,
  judge: sonnet,
  harness,
  run: 1,
  answerKey,
  referenceGraph,
});
const answerFor = (result: Awaited<ReturnType<typeof runL2>>, track: string, qid: string) =>
  result.answers.find((a) => a.track === track && a.qid === qid)!;

describe("runL2", () => {
  it("asks each track once, with the canary, and grades cited answers against the key", async () => {
    const { harness, calls } = fakeViewer(answers);

    const result = await runL2(input(harness));

    expect(calls).toHaveLength(3);
    expect(calls.every((prompt) => /- canary: What does the component named relay-[0-9a-f]{6} do\?/.test(prompt))).toBe(true);
    expect(answerFor(result, "SV", "Q1")).toMatchObject({ grade: 1, void_reason: null, cited_beats: ["c1-1"] });
    expect(answerFor(result, "SV", "Q2")).toMatchObject({ grade: 2 / 3, edge_f1: 0.5 });
    expect(answerFor(result, "SV", "Q5").grade).toBe(2);
    expect(answerFor(result, "SV", "Q3").grade).toBeNull();
    expect(result.trusted).toBe(true);
  });

  it("shows the muted track no narration and the spoken track no screen", async () => {
    const { harness, calls } = fakeViewer(answers);

    await runL2(input(harness));

    const [s, , v] = calls;
    expect(s).toContain("spoken: A courier prints");
    expect(s).not.toContain("headline:");
    expect(v).toContain("headline: Ghost labels");
    expect(v).not.toContain("spoken:");
  });

  it("scores an uncited answer 0, even when it names every key term", async () => {
    const result = await runL2(input(fakeViewer(answers, { cite: "none" }).harness));

    expect(answerFor(result, "SV", "Q1")).toMatchObject({ grade: 0, void_reason: "no evidence" });
    expect(answerFor(result, "SV", "Q2")).toMatchObject({ grade: 0, edge_f1: 0 });
  });

  it("scores 0 on the muted track an answer that quotes the narration", async () => {
    const result = await runL2(input(fakeViewer(answers, { cite: "spoken" }).harness));

    expect(answerFor(result, "SV", "Q1").grade).toBe(1);
    expect(answerFor(result, "V", "Q1")).toMatchObject({ grade: 0, void_reason: "quote not found in c1-1" });
  });

  it("does not trust a run whose viewer answers the unanswerable canary", async () => {
    const result = await runL2(input(fakeViewer(answers, { answerCanary: true }).harness));

    expect(result.trusted).toBe(false);
    expect(result.canaries.map((c) => c.got)).toEqual(["answered", "answered", "answered"]);
  });
});

describe("layoutScores", () => {
  it("matches edges by name regardless of case, bullets and protocol", () => {
    expect(layoutScores("- scanner -> DESK SERVER : grpc\n* Desk server -> Ledger", referenceGraph)).toEqual({ recall: 1, f1: 1 });
    expect(layoutScores("no layout here", referenceGraph)).toEqual({ recall: 0, f1: 0 });
  });
});

describe("l2EvalVersion", () => {
  it("changes when the rubric, the answer key or the judge changes", () => {
    const base = l2EvalVersion({ rubric, judge: sonnet, answerKey, referenceGraph });

    expect(l2EvalVersion({ rubric: `${rubric}\nBe brief.`, judge: sonnet, answerKey, referenceGraph })).not.toBe(base);
    expect(l2EvalVersion({ rubric, judge: sonnet, answerKey: answerKey.slice(1), referenceGraph })).not.toBe(base);
    expect(l2EvalVersion({ rubric, judge: { ...sonnet, model: "opus" }, answerKey, referenceGraph })).not.toBe(base);
  });
});
