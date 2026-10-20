import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEvalCli } from "./eval-cli.js";
import { readRubric } from "./eval-evidence.js";
import { readTsv, scriptSha } from "./eval-store.js";
import type { JudgeCall, JudgeHarness, JudgeReply } from "./eval-harness.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";

const spikeBeat = (id: string, chapter: string, spoken: string, titles: string[]) => ({ id, chapter, function: "EXPLAIN", plannedS: 12, spoken, visual: { titles } });
/** An invented parcel desk in two chapters. */
const script = {
  id: "synthetic-cold",
  beats: [
    spikeBeat("c1-1", "ch1", "The desk scans, weighs and labels every parcel.", ["Scan", "Weigh", "Label"]),
    spikeBeat("c2-1", "ch2", "Every scan lands in the ledger overnight.", ["Ledger"]),
  ],
};

const TERMS_RUBRIC = readRubric("l1-cold-terms.md");

/**
 * A viewer that admits it was told nothing, so the canary passes; `guess` makes it answer every question. Asked for
 * the terms it cannot define, its nth call names `terms[n]`.
 */
function fakeViewer(options: { guess?: boolean; terms?: string[][] } = {}) {
  const calls: string[] = [];
  const termCalls: string[] = [];
  const harness: JudgeHarness = async <T>({ prompt, schema }: JudgeCall<T>): Promise<JudgeReply<T>> => {
    if (prompt.startsWith(TERMS_RUBRIC)) {
      termCalls.push(prompt);
      return { ok: true, output: schema.parse({ terms: options.terms?.[termCalls.length - 1] ?? [] }), usd: 0.03, tokensIn: 500, tokensOut: 20 };
    }
    calls.push(prompt);
    const qids = [...prompt.matchAll(/^- (q\d+): /gm)].map((m) => m[1]!);
    const answer = (qid: string) => ({ qid, not_stated: !options.guess, what: "", what_quotes: [], why: "", why_quotes: [], odd_one_out: null });
    return { ok: true, output: schema.parse({ answers: qids.map(answer), summary: "A parcel desk." }), usd: 0.01, tokensIn: 200, tokensOut: 40 };
  };
  return { harness, calls, termCalls };
}

let dir: string;
const write = (name: string, value: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
};
const judgeFile = (model: string) => write(`judge-${model}.json`, { provider: "claude-print", model });
const cold = (harness: JudgeHarness, model = "sonnet", ...extra: string[]) =>
  runEvalCli(["eval", "cold", write("script.json", script), "--judge", judgeFile(model), "--bench", join(dir, "bench"), ...extra], { harness: () => harness });
const allRecords = () => readFileSync(join(dir, "bench/evals/runs.jsonl"), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
const runRecords = () => allRecords().filter((r) => r.eval_id === "L1-cold");
const evalRows = (name: string) => readTsv(join(dir, "bench/evals", name));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "explainer-cold-cli-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("explainer eval cold", () => {
  it("runs three fresh viewers by default, one call a chapter, and stores an L1-cold run record for each", async () => {
    const viewer = fakeViewer();

    const code = await cold(viewer.harness);

    expect(code).toBe(0);
    expect(viewer.calls).toHaveLength(6);
    const records = runRecords();
    expect(records.map((r) => r.run)).toEqual([1, 2, 3]);
    expect(records.every((r) => r.eval_id === "L1-cold" && r.judge === "claude-print:sonnet" && r.script_sha === scriptSha(script))).toBe(true);
    expect(new Set(records.map((r) => r.eval_version)).size).toBe(1);
    expect(records[0]).toMatchObject({ config_id: "unconfigured", usd: 0.02, tokens_in: 400, tokens_out: 80 });
  });

  it("appends score, chapter and canary rows keyed by eval_version and run", async () => {
    await cold(fakeViewer().harness, "sonnet", "--runs", "1");

    const version = runRecords()[0]!.eval_version;
    const scores = evalRows("cold-scores.tsv");
    expect(scores.filter((r) => r.kind === "what-why").map((r) => [r.chapter, r.item, r.score])).toEqual([
      ["ch1", "Scan", "0"],
      ["ch1", "Weigh", "0"],
      ["ch1", "Label", "0"],
      ["ch2", "Ledger", "0"],
    ]);
    expect(scores.every((r) => r.eval_version === version && r.run === "1")).toBe(true);
    expect(evalRows("cold-chapters.tsv").map((r) => [r.chapter, r.minutes, r.undefined_items, r.undefined_per_minute])).toEqual([
      ["ch1", "0.2", "3", "15"],
      ["ch2", "0.2", "1", "5"],
    ]);
    const relay = expect.stringMatching(/^relay-[0-9a-f]{6}$/);
    expect(evalRows("canaries.tsv").map((r) => [r.eval_id, r.canary, r.got, r.pass])).toEqual([
      ["L1-cold", relay, "not_stated", "true"],
      ["L1-cold", relay, "not_stated", "true"],
    ]);
  });

  // Mutation: dropping the glossary on the way from the file to the probe leaves spoken-only terms unasked.
  it.each([
    ["spike", { ...script, video: { glossary: [{ name: "desk", job: "takes parcels in" }] } }, "desk", "ch1"],
    ["v1", { ...scriptWith(), video: { ...scriptWith().video, glossary: [{ name: "ledger", job: "holds parcel rows" }] } }, "ledger", "ch2"],
  ])("asks a %s script's glossary term where it is first spoken", async (format, glossed, term, chapter) => {
    const file = write("glossed.json", glossed);

    await runEvalCli(["eval", "cold", file, "--format", format, "--judge", judgeFile("sonnet"), "--bench", join(dir, "bench"), "--runs", "1"], { harness: () => fakeViewer().harness });

    const asked = evalRows("cold-scores.tsv").filter((r) => r.kind === "spoken-term");
    expect(asked.map((r) => [r.chapter, r.item, r.score])).toEqual([[chapter, term, "0"]]);
  });

  // Mutation: leaving the judge identity out of eval_version gives both judges one version, mixing their rows.
  it("gives runs under two judge configs different eval_versions", async () => {
    await cold(fakeViewer().harness, "sonnet", "--runs", "1");
    await cold(fakeViewer().harness, "opus", "--runs", "1");

    const [sonnetRun, opusRun] = runRecords();
    expect([sonnetRun?.judge, opusRun?.judge]).toEqual(["claude-print:sonnet", "claude-print:opus"]);
    expect(sonnetRun?.eval_version).not.toBe(opusRun?.eval_version);
  });

  it("exits 1 when the viewer answers the canary, still writing the run's rows", async () => {
    const code = await cold(fakeViewer({ guess: true }).harness, "sonnet", "--runs", "1");

    expect(code).toBe(1);
    expect(evalRows("canaries.tsv").map((r) => r.pass)).toEqual(["false", "false"]);
    expect(runRecords()).toHaveLength(1);
  });

  // Mutation: a quorum of one asks "parcel", which only one viewer named.
  it("asks the terms two of three viewers could not define, folding case and plural, and stores the pass's spend", async () => {
    const viewer = fakeViewer({ terms: [["Desks", "parcel"], ["desk"], []] });

    await cold(viewer.harness, "sonnet", "--runs", "1");

    expect(viewer.termCalls).toHaveLength(3);
    expect(viewer.termCalls[0]).toContain("## Chapter ch2");
    const asked = evalRows("cold-scores.tsv").filter((r) => r.kind === "spoken-term");
    expect(asked.map((r) => [r.chapter, r.item, r.score])).toEqual([["ch1", "desk", "0"]]);
    const terms = allRecords().filter((r) => r.eval_id === "L1-cold-terms");
    expect(terms).toMatchObject([{ run: 1, usd: 0.09, tokens_in: 1500, judge: "claude-print:sonnet" }]);
  });

  it("exits 1 when a terms call fails, since its questions go unasked", async () => {
    const viewer = fakeViewer();
    const failing: JudgeHarness = async (call) =>
      call.prompt.startsWith(TERMS_RUBRIC) ? { ok: false, reason: "timeout: no reply", usd: 0, tokensIn: 0, tokensOut: 0 } : viewer.harness(call);

    expect(await cold(failing, "sonnet", "--runs", "1")).toBe(1);
  });

  it("adds each run's reader-gap group scores to its line when given labels", async () => {
    const labels = write("labels.json", {
      schema: "labels/v1",
      script: "synthetic-cold",
      source: "invented",
      checks: [{ check: "M1", check_ids: [], level: "beat", true: [], false: [], borderline: [] }],
      owner_named: { true: [], borderline: [] },
      items: [{ group: "ledger", items: ["ledger"], first_used: ["c2-1"] }],
    });

    await cold(fakeViewer().harness, "sonnet", "--runs", "1", "--labels", labels);

    const lines = vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(lines.find((l) => l.run === 1)).toMatchObject({ reader_gaps: [{ group: "ledger", asked: ["Ledger"], score: 0 }] });
  });

  it("exits 2 on a judge config it cannot parse, before any call", async () => {
    const viewer = fakeViewer();

    const code = await runEvalCli(["eval", "cold", write("script.json", script), "--judge", write("judge.json", { provider: "gpt" }), "--bench", join(dir, "bench")], { harness: () => viewer.harness });

    expect(code).toBe(2);
    expect(viewer.calls).toEqual([]);
  });
});
