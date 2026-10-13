import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEvalCli, type EvalCliDeps } from "./eval-cli.js";
import { readRubric } from "./eval-evidence.js";
import { l1EvalVersion } from "./eval-judge.js";
import { scriptSha } from "./eval-store.js";
import { fakeJudge, fakeViewer, sonnet, twoChapters } from "./judge-fakes.test-helpers.js";

let dir: string;
let logs: string[];
const write = (name: string, value: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
};
const lines = (name: string) => readFileSync(join(dir, "bench/evals", name), "utf8").trimEnd().split("\n");
const judged = (command: string, deps: EvalCliDeps, ...extra: string[]) =>
  runEvalCli(
    ["eval", command, write("script.json", twoChapters), "--config", "tour-short/script-v1-01", "--rules", write("rules.yaml", "rules: []\n"), "--judge", write("judge.json", { provider: "claude-print", model: "sonnet" }), "--bench", join(dir, "bench"), ...extra],
    deps,
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "explainer-judge-cli-"));
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

describe("explainer eval l1", () => {
  it("writes score and canary rows and a run record per run, keyed to the configured judge", async () => {
    const seen: unknown[] = [];
    const { harness } = fakeJudge();

    const code = await judged("l1", { harness: (config) => (seen.push(config), harness) }, "--runs", "2");

    const version = l1EvalVersion({ beat: readRubric("l1-beat.md"), script: readRubric("l1-script.md") }, sonnet);
    expect(code).toBe(0);
    expect(seen).toEqual([sonnet]);
    expect(lines("beat-scores.tsv")).toHaveLength(1 + 2 * 18);
    expect(lines("script-scores.tsv")[1]).toMatch(new RegExp(`^tour-short/script-v1-01\\t${scriptSha(twoChapters)}\\tL1-judge\\t${version}\\tclaude-print:sonnet\\t1\\tJ1\\t4\\tc1-1:A courier prints\\t$`));
    expect(lines("canaries.tsv").slice(1).every((row) => row.endsWith("\tfail\ttrue"))).toBe(true);
    const runs = lines("runs.jsonl").map((line) => JSON.parse(line));
    expect(runs.map((r) => [r.eval_id, r.eval_version, r.judge, r.run, r.usd])).toEqual([
      ["L1-judge", version, "claude-print:sonnet", 1, 0.03],
      ["L1-judge", version, "claude-print:sonnet", 2, 0.03],
    ]);
  });

  it("exits 1 when the judge passes a canary, and 2 on a judge config with no model", async () => {
    expect(await judged("l1", { harness: () => fakeJudge({ lenient: true }).harness })).toBe(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({ trusted: false, failed_canaries: expect.arrayContaining(["process-narration:B5=pass"]) });

    const noModel = await runEvalCli(["eval", "l1", write("s.json", twoChapters), "--config", "c", "--rules", write("r.yaml", ""), "--judge", write("j.json", { provider: "claude-print" })]);
    expect(noModel).toBe(2);
  });
});

describe("explainer eval l2", () => {
  it("writes one viewer row per track and question, graded against the answer key", async () => {
    const key = write("answer-key.tsv", "qid\tfact_ids\trequired_terms\nQ1\tF1\tcourier, label\n");
    const graph = write("reference-graph.tsv", "from\tto\tprotocol\tfact_id\nScanner\tDesk server\thttp\tF2\n");
    const { harness } = fakeViewer({ Q1: "A courier gets no ghost label.", Q2: "Scanner -> Desk server : http" });

    const code = await judged("l2", { harness: () => harness }, "--answer-key", key, "--reference-graph", graph);

    expect(code).toBe(0);
    const rows = lines("viewer.tsv").slice(1).map((row) => row.split("\t"));
    expect(rows).toHaveLength(3 * 9);
    expect(rows.find(([, , , , track, qid]) => track === "SV" && qid === "Q1")!.slice(10)).toEqual(["1", "", ""]);
    expect(rows.find(([, , , , track, qid]) => track === "SV" && qid === "Q2")!.slice(10)).toEqual(["1", "1", ""]);
    expect(lines("canaries.tsv").slice(1).map((row) => row.split("\t").slice(6))).toEqual(
      ["S", "SV", "V"].map((track) => [`unanswerable-${track}`, "canary", "not_stated", "true"]),
    );
  });
});

describe("explainer eval smoke", () => {
  it("skips a codex judge with no cached login, naming the fix, and never calls it", async () => {
    const harness = vi.fn();

    const code = await runEvalCli(["eval", "smoke", "--judge", write("codex.json", { provider: "codex", model: "gpt-x" })], {
      harness,
      codexUnavailable: () => "codex is not logged in on this host; run `codex login`",
    });

    expect(code).toBe(0);
    expect(JSON.parse(logs[0]!)).toEqual({ judge: "codex:gpt-x", skipped: "codex is not logged in on this host; run `codex login`" });
    expect(harness).not.toHaveBeenCalled();
  });

  it("passes when the configured judge answers the schema, and fails when the call fails", async () => {
    const judge = write("judge.json", { provider: "claude-print", model: "haiku" });
    const answer = (ok: boolean) => () => async () => (ok ? { ok: true, output: { ok: true }, usd: 0.001, tokensIn: 1, tokensOut: 1 } : { ok: false, reason: "auth_misconfigured: logged out", usd: 0, tokensIn: 0, tokensOut: 0 });

    expect(await runEvalCli(["eval", "smoke", "--judge", judge], { harness: answer(true) as never })).toBe(0);
    expect(await runEvalCli(["eval", "smoke", "--judge", judge], { harness: answer(false) as never })).toBe(1);
    expect(JSON.parse(logs[1]!)).toMatchObject({ judge: "claude-print:haiku", ok: false, reason: "auth_misconfigured: logged out" });
  });
});
