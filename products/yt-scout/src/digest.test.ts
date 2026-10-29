import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestVideo, type DigestDeps } from "./digest.js";
import type { Retrieval } from "./digest-retrieval.js";
import { cliRetriever, keyword } from "./digest-retrieval.js";
import { tempTree, type TempTree } from "./fixtures.test-helpers.js";
import type { ScoreCard } from "./score-card.js";
import type { DigestRunner, ScoreCall } from "./seams.js";

const CARD: ScoreCard = {
  actionable: 4,
  novelty: 3,
  evidence: 3,
  pain_points: ["load"],
  summary: "A synthetic talk.",
  techniques: [{ ts: "01:05", what: "Queue workers through a spool directory." }],
  caveat: "",
};

const LOW_CARD: ScoreCard = { ...CARD, actionable: 2, novelty: 2, evidence: 2 };

const RETRIEVAL: Retrieval = {
  priorDigests: ["vidAAAAAAAA | p3-4 | first earlier passage", "vidBBBBBBBB | p9-10 | second earlier passage"],
  tasks: [
    { id: "TP-200", title: "Second task" },
    { id: "TP-100", title: "First task" },
  ],
};

let tree: TempTree;
let calls: ScoreCall[];

const runner: DigestRunner = async (call) => {
  calls.push(call);
  return { ok: true, value: { output: "## Summary\n\nx", costUsd: 0.12, inputTokens: 5000, outputTokens: 600, model: call.model } };
};

const deps = (over: Partial<DigestDeps> = {}): DigestDeps => ({
  runner,
  retriever: async () => RETRIEVAL,
  model: "model-b",
  rowsDir: path.join(tree.root, "rows"),
  runId: "run-1",
  workflowVersion: "sha-1",
  thresholdTotal: 10,
  alsoIfAnyAxis: 5,
  now: () => new Date("2026-10-29T03:00:00Z"),
  ...over,
});

const video = (id: string, card: ScoreCard = CARD) => ({
  id,
  source: "confTalks",
  title: "Synthetic Talk",
  card,
  transcriptPath: path.join(tree.root, `${id}.md`),
});

const rows = () =>
  readFileSync(path.join(tree.root, "rows", "steps-2026-10.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

beforeEach(() => {
  tree = tempTree();
  calls = [];
  for (const id of ["v1", "v2", "v3", "v4"]) tree.write(`${id}.md`, `---\nid: "${id}"\n---\n\n[0:00] Opening.\n\n[1:05] Spool directory queue.\n`);
});
afterEach(() => tree.cleanup());

describe("digest step", () => {
  it("renders the retrieval into the prompt in a fixed order: prior passages as returned, tasks sorted by id", async () => {
    await digestVideo(deps(), video("v1"));

    const prompt = calls[0]!.prompt;
    const at = (s: string) => prompt.indexOf(s);
    expect(at("first earlier passage")).toBeGreaterThan(-1);
    expect(at("first earlier passage")).toBeLessThan(at("second earlier passage"));
    expect(at("TP-100: First task")).toBeGreaterThan(-1);
    expect(at("TP-100: First task")).toBeLessThan(at("TP-200: Second task"));
    expect(at("second earlier passage")).toBeLessThan(at("TP-100: First task"));
    expect(prompt).toContain("Spool directory queue.");
    expect(prompt).not.toContain("{{");
  });

  it("writes the digest beside the transcript and appends a costed row", async () => {
    const result = await digestVideo(deps(), video("v1"));

    expect(result).toMatchObject({ status: "written", path: path.join(tree.root, "v1.digest.md") });
    expect(readFileSync(path.join(tree.root, "v1.digest.md"), "utf8")).toBe("## Summary\n\nx\n");
    expect(rows()).toEqual([expect.objectContaining({ step: "digest", outcome: "ok", cost_usd: 0.12, model: "model-b" })]);
  });

  it("stops at three digests a day and defers the fourth without a call", async () => {
    for (const id of ["v1", "v2", "v3"]) await digestVideo(deps(), video(id));
    const fourth = await digestVideo(deps(), video("v4"));

    expect(fourth).toEqual({ status: "capped" });
    expect(calls).toHaveLength(3);
    expect(rows().map((r) => r.outcome)).toEqual(["ok", "ok", "ok", "deferred"]);
  });

  it("counts the cap per day, so tomorrow starts clear", async () => {
    for (const id of ["v1", "v2", "v3"]) await digestVideo(deps(), video(id));

    const next = await digestVideo(deps({ now: () => new Date("2026-10-30T03:00:00Z") }), video("v4"));

    expect(next.status).toBe("written");
  });

  it("makes no call for a card under the threshold with no axis at 5", async () => {
    const result = await digestVideo(deps(), video("v1", LOW_CARD));

    expect(result).toEqual({ status: "below_threshold" });
    expect(calls).toHaveLength(0);
    expect(rows()).toEqual([expect.objectContaining({ outcome: "skip" })]);
  });

  it("digests a low-total card when one axis is 5", async () => {
    const result = await digestVideo(deps(), video("v1", { ...LOW_CARD, evidence: 5 }));

    expect(result.status).toBe("written");
  });

  it("records a runner failure as a fail row and writes no file", async () => {
    const failing: DigestRunner = async () => ({ ok: false, errorClass: "other", message: "boom" });

    const result = await digestVideo(deps({ runner: failing }), video("v1"));

    expect(result).toMatchObject({ status: "failed", errorClass: "other" });
    expect(rows()[0]).toMatchObject({ outcome: "fail", error_class: "other" });
    expect(() => readFileSync(path.join(tree.root, "v1.digest.md"))).toThrow();
  });

  it("records what a failed call billed on its row and in the result", async () => {
    const usage = { costUsd: 0.75, inputTokens: 9000, outputTokens: 1200 };
    const failing: DigestRunner = async () => ({ ok: false, errorClass: "budget", message: "over budget", usage });

    const result = await digestVideo(deps({ runner: failing }), video("v1"));

    expect(result).toEqual({ status: "failed", errorClass: "budget", costUsd: 0.75 });
    expect(rows()[0]).toMatchObject({ outcome: "deferred", cost_usd: 0.75, input_tokens: 9000, output_tokens: 1200 });
  });
});

describe("cli retriever", () => {
  it("queries corpus-query per technique and active-work once, keeping only task hits", async () => {
    const seen: string[][] = [];
    const exec = async (file: string, args: string[]) => {
      seen.push([file, ...args]);
      if (file === "corpus-query") return "vidAAAAAAAA | p1-2 | passage\n";
      return JSON.stringify({ hits: [{ class: "notes", ref: "note:x", title: "N" }, { class: "tasks", ref: "task:TP-100", title: "First task" }] });
    };

    const r = await cliRetriever({ exec, corpusRoot: "/corpus" })(CARD);

    expect(r).toEqual({ priorDigests: ["vidAAAAAAAA | p1-2 | passage"], tasks: [{ id: "TP-100", title: "First task" }] });
    expect(seen[0]).toEqual(["corpus-query", "hits", "/corpus", "--phrase", "directory", "--window", "1"]);
    expect(seen[1]![0]).toBe("active-work");
  });

  it("keeps task hits when another hit has a null title", async () => {
    const exec = async (file: string) =>
      file === "corpus-query" ? "" : JSON.stringify({ hits: [{ class: "notes", ref: "note:y", title: null }, { class: "tasks", ref: "task:TP-100", title: "First task" }] });

    const r = await cliRetriever({ exec, corpusRoot: "/corpus" })(CARD);

    expect(r.tasks).toEqual([{ id: "TP-100", title: "First task" }]);
  });

  it("degrades to empty retrieval when both CLIs fail", async () => {
    const exec = async () => {
      throw new Error("not installed");
    };

    expect(await cliRetriever({ exec, corpusRoot: "/corpus" })(CARD)).toEqual({ priorDigests: [], tasks: [] });
  });

  it("picks the longest non-stop word as the keyword", () => {
    expect(keyword("Use the spool directory")).toBe("directory");
    expect(keyword("a b")).toBeUndefined();
  });
});
