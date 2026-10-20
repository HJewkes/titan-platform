import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEvalCli } from "./eval-cli.js";
import type { JudgeCall, JudgeHarness, JudgeReply } from "./eval-harness.js";
import { readTsv, scriptSha } from "./eval-store.js";

const spikeBeat = (id: string, chapter: string, spoken: string, titles: string[]) => ({ id, chapter, function: "EXPLAIN", plannedS: 12, spoken, visual: { titles } });
/** An invented parcel desk: ch1 lists three steps, ch2 names one ledger and is routed nowhere. */
const script = {
  id: "synthetic-items",
  beats: [
    spikeBeat("c1-1", "ch1", "The desk scans, weighs and labels every parcel.", ["Scan", "Weigh", "Label"]),
    spikeBeat("c2-1", "ch2", "Every scan lands in the ledger overnight.", ["Ledger"]),
  ],
};

/** A judge that quotes each asked beat's first words and refuses every question; `lenient` calls the canary explained too. */
function fakeJudge(options: { lenient?: boolean } = {}) {
  const calls: string[] = [];
  const harness: JudgeHarness = async <T>({ prompt, schema }: JudgeCall<T>): Promise<JudgeReply<T>> => {
    calls.push(prompt);
    const spoken = new Map([...prompt.matchAll(/^\[([^\]]+)\]\nspoken: (.*)$/gm)].map((m) => [m[1]!, m[2]!]));
    const answers = [...prompt.matchAll(/^- (q\d+): (?:In )?([^\s,]+)/gm)].map(([, qid, beat]) => ({
      qid,
      pass: Boolean(options.lenient),
      odd_one_out: null,
      evidence: [{ beat, quote: spoken.get(beat!)!.split(" ").slice(0, 3).join(" ") }],
    }));
    return { ok: true, output: schema.parse({ answers }), usd: 0.01, tokensIn: 200, tokensOut: 40 };
  };
  return { harness, calls };
}

let dir: string;
const write = (name: string, value: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
};
const items = (harness: JudgeHarness, ...extra: string[]) =>
  runEvalCli(["eval", "items", write("script.json", script), "--judge", write("judge.json", { provider: "claude-print", model: "sonnet" }), "--bench", join(dir, "bench"), ...extra], {
    harness: () => harness,
  });
const runRecords = () => readFileSync(join(dir, "bench/evals/runs.jsonl"), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
const evalRows = (name: string) => readTsv(join(dir, "bench/evals", name));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "explainer-items-cli-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("explainer eval items", () => {
  it("runs three fresh judges by default, one call per routed chapter, and stores an L1-items run record for each", async () => {
    const judge = fakeJudge();

    const code = await items(judge.harness);

    expect(code).toBe(0);
    expect(judge.calls).toHaveLength(3);
    const records = runRecords();
    expect(records.map((r) => r.run)).toEqual([1, 2, 3]);
    expect(records.every((r) => r.eval_id === "L1-items" && r.script_sha === scriptSha(script))).toBe(true);
  });

  it("appends one items-scores row per routed question and one canary row per judged chapter", async () => {
    await items(fakeJudge().harness, "--runs", "1");

    const rows = evalRows("items-scores.tsv");
    expect(rows.map((r) => [r.kind, r.subject, r.pass])).toEqual([
      ["explained", "Scan", "false"],
      ["explained", "Weigh", "false"],
      ["explained", "Label", "false"],
      ["odd-one-out", "Scan; Weigh; Label", "true"],
    ]);
    expect(rows.every((r) => r.eval_id === "L1-items" && r.chapter === "ch1" && r.beat === "c1-1")).toBe(true);
    expect(evalRows("canaries.tsv")).toEqual([expect.objectContaining({ eval_id: "L1-items", dim: "explained", got: "not_explained", pass: "true" })]);
  });

  it("exits 1 when a judge calls the canary's name explained", async () => {
    expect(await items(fakeJudge({ lenient: true }).harness, "--runs", "1")).toBe(1);
  });

  it("exits 2 on a judge config it cannot read", async () => {
    const code = await runEvalCli(["eval", "items", write("script.json", script), "--judge", write("judge.json", { provider: "gpt" }), "--bench", join(dir, "bench")]);

    expect(code).toBe(2);
  });
});
