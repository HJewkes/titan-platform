import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempTree, type TempTree } from "./fixtures.test-helpers.js";
import { scoreVideo, type ScoreDeps } from "./score.js";
import { checkTimestamps } from "./score-card.js";
import { buildScorePrompt, extractRubric } from "./score-prompt.js";
import type { ScoreCall, ScoreRunner } from "./seams.js";

const RUBRIC = `# Rubric

Batch preamble that does not apply.

## The owner's system

Baseline text.

## Scores

- actionable: 0 to 5

## Output

Write JSONL to a file.
`;

const TRANSCRIPT = `---
id: "abc123def45"
title: "Synthetic Talk"
---

# Synthetic Talk

[0:00] Opening words.

[1:05] The first technique is explained here.

[10:30] The second technique is explained here.
`;

const CARD = {
  actionable: 4,
  novelty: 3,
  evidence: 2,
  pain_points: ["load", "evals"],
  summary: "A synthetic talk.",
  techniques: [
    { ts: "01:05", what: "First technique." },
    { ts: "10:30", what: "Second technique." },
  ],
  caveat: "",
};

let tree: TempTree;
let calls: ScoreCall[];

const ok = (output: unknown): ScoreRunner => async (call) => {
  calls.push(call);
  return { ok: true, value: { output, costUsd: 0.03, inputTokens: 1000, outputTokens: 200, model: call.model } };
};

const deps = (runner: ScoreRunner): ScoreDeps => ({
  runner,
  rubric: RUBRIC,
  model: "model-a",
  rowsDir: path.join(tree.root, "rows"),
  casesDir: path.join(tree.root, "cases"),
  runId: "run-1",
  workflowVersion: "sha-1",
  now: () => new Date("2026-10-29T03:00:00Z"),
});

const input = () => ({
  id: "abc123def45",
  source: "confTalks",
  title: "Synthetic Talk",
  transcriptPath: path.join(tree.root, "abc123def45.md"),
  outputPath: path.join(tree.root, "abc123def45.score.json"),
});

const rows = () =>
  readFileSync(path.join(tree.root, "rows", "steps-2026-10.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

beforeEach(() => {
  tree = tempTree();
  calls = [];
  tree.write("abc123def45.md", TRANSCRIPT);
});
afterEach(() => tree.cleanup());

describe("score step", () => {
  it("stores the card from a fake runner and appends a row with cost", async () => {
    const result = await scoreVideo(deps(ok(CARD)), input());

    expect(result.ok).toBe(true);
    const stored = JSON.parse(readFileSync(input().outputPath, "utf8"));
    expect(stored).toMatchObject({ id: "abc123def45", total: 9, partial: false });
    expect(stored.techniques).toHaveLength(2);
    expect(rows()).toEqual([
      expect.objectContaining({ step: "score", attempt: 1, outcome: "ok", error_class: null, cost_usd: 0.03, input_tokens: 1000, output_tokens: 200 }),
    ]);
  });

  it("drops a technique whose ts is not in the transcript and files ts_invalid", async () => {
    const card = { ...CARD, techniques: [...CARD.techniques, { ts: "05:00", what: "Invented." }] };

    const result = await scoreVideo(deps(ok(card)), input());

    expect(result.errorClass).toBe("ts_invalid");
    expect(result.card!.techniques.map((t) => t.ts)).toEqual(["01:05", "10:30"]);
    expect(rows()[0]).toMatchObject({ outcome: "fallback", error_class: "ts_invalid" });
    const file = JSON.parse(readFileSync(path.join(tree.root, "cases", "score-abc123def45.json"), "utf8"));
    expect(file.label).toBe("ts_invalid");
    expect(JSON.stringify(file)).not.toContain("Opening words");
  });

  it("turns schema-invalid output into fail plus a case after one more attempt", async () => {
    const result = await scoreVideo(deps(ok({ ...CARD, novelty: 9 })), input());

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(2);
    expect(rows().map((r) => [r.attempt, r.outcome, r.error_class])).toEqual([
      [1, "retry", "schema_invalid"],
      [2, "fail", "schema_invalid"],
    ]);
    expect(readdirSync(path.join(tree.root, "cases"))).toEqual(["score-abc123def45.json"]);
  });

  it("does not retry or file a case for a budget stop", async () => {
    const runner: ScoreRunner = async () => ({ ok: false, errorClass: "budget", message: "cap" });

    const result = await scoreVideo(deps(runner), input());

    expect(result.errorClass).toBe("budget");
    expect(rows().map((r) => r.outcome)).toEqual(["deferred"]);
  });

  it("keeps prompt_sha stable across runs and moves input_sha with the transcript", async () => {
    await scoreVideo(deps(ok(CARD)), input());
    await scoreVideo(deps(ok(CARD)), input());
    tree.write("abc123def45.md", `${TRANSCRIPT}\n[11:00] More.\n`);
    await scoreVideo(deps(ok(CARD)), input());

    const [a, b, c] = rows();
    expect(a.prompt_sha).toBe(b.prompt_sha);
    expect(a.input_sha).toBe(b.input_sha);
    expect(c.prompt_sha).toBe(a.prompt_sha);
    expect(c.input_sha).not.toBe(a.input_sha);
  });

  it("scores only the start of a video over two hours and marks the card partial", async () => {
    tree.write("abc123def45.md", `[0:00] ${"word ".repeat(40_000)}\n[1:05] tail marker\n`);

    const result = await scoreVideo(deps(ok({ ...CARD, techniques: [] })), { ...input(), durationSeconds: 9000 });

    expect(result.card!.partial).toBe(true);
    expect(calls[0]!.prompt).not.toContain("tail marker");
  });
});

describe("timestamp check", () => {
  it("accepts padded and unpadded anchors and hour anchors, and rejects near misses", () => {
    const transcript = "[0:09] a\n[1:02:03] b\n";
    const t = (ts: string) => ({ ts, what: "x" });

    const { kept, dropped } = checkTimestamps([t("00:09"), t("62:03"), t("1:02:03"), t("00:10"), t("nope"), t("[0:09]")], transcript);

    expect(kept.map((k) => k.ts)).toEqual(["00:09", "62:03", "1:02:03", "[0:09]"]);
    expect(dropped.map((d) => d.ts)).toEqual(["00:10", "nope"]);
  });
});

describe("score prompt", () => {
  it("keeps only the system and scores sections of the rubric", () => {
    const text = extractRubric(RUBRIC);

    expect(text).toContain("Baseline text.");
    expect(text).toContain("actionable: 0 to 5");
    expect(text).not.toContain("JSONL");
    expect(text).not.toContain("Batch preamble");
  });

  it("refuses a rubric missing a section", () => {
    expect(() => extractRubric("## Scores\n\nx\n")).toThrow(/missing a required section/);
  });

  it("fills the shipped template and does not interpret $ patterns in the transcript", () => {
    const p = buildScorePrompt({ title: "T", transcript: "cost is $& and $1", rubric: RUBRIC });

    expect(p.prompt).toContain("cost is $& and $1");
    expect(p.prompt).not.toContain("{{");
  });
});
