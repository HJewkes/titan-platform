import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditCandidates, disagrees, runAudit, selectAuditSample, type AuditCandidate } from "./eval-audit.js";
import { readCases } from "./eval-cases.js";
import { replayCases, type ReplayOptions } from "./eval-replay.js";
import { runCli } from "./cli.js";
import { scoreVideo } from "./score.js";
import { tempTree, VALID_WATCHLIST, type TempTree } from "./fixtures.test-helpers.js";
import type { ScoreCall, ScoreRunner } from "./seams.js";

const RUBRIC = "## The owner's system\n\nx\n\n## Scores\n\ny\n";
const SECRET = "Synthetic spoken sentence that must never reach a case file.";
const TRANSCRIPT = `---\ntitle: "Synthetic Talk"\n---\n\n[0:30] ${SECRET}\n`;

let tree: TempTree;
let out: string[];

const cardJson = (id: string, total: number) => ({
  id,
  title: `Talk ${id}`,
  actionable: total,
  novelty: 0,
  evidence: 0,
  pain_points: [],
  summary: "s",
  techniques: [],
  caveat: "",
  total,
  partial: false,
  prompt_sha: "p-sha",
  model: "model-a",
});

/** A fake runner that answers with these totals in call order and prices each call at 0.03. */
const totals = (...ts: number[]): ScoreRunner => {
  let i = 0;
  return async (call) => ({
    ok: true,
    value: { output: { actionable: Math.min(ts[i++]!, 5), novelty: 0, evidence: 0, pain_points: [], summary: "s", techniques: [], caveat: "" }, costUsd: 0.03, inputTokens: 1, outputTokens: 1, model: call.model },
  });
};

function seedCard(id: string, total: number): void {
  tree.write(`${id}.md`, TRANSCRIPT);
  tree.write(`${id}.score.json`, JSON.stringify(cardJson(id, total)));
}

const SCORED = { actionable: 4, novelty: 3, evidence: 2, pain_points: [], summary: "s", techniques: [], caveat: "" };
/** Past the 120k-char cut, so a replay that ignored `partial` would hash different text. */
const LONG_TRANSCRIPT = `${TRANSCRIPT}\n${"[0:30] more words. ".repeat(8000)}`;

/** Answers with this output and records each call, so a test can compare the replayed prompt with the original. */
const recording = (output: unknown, calls: ScoreCall[]): ScoreRunner => async (call) => {
  calls.push(call);
  return { ok: true, value: { output, costUsd: 0.03, inputTokens: 1, outputTokens: 1, model: call.model } };
};

/** Files a case the way the score step does: a long video scored with an invented ts, or a runner whose output never parses. */
async function scoreAutomatic(id: string, output: unknown, calls: ScoreCall[]): Promise<void> {
  tree.write(`${id}.md`, LONG_TRANSCRIPT);
  const deps = { runner: recording(output, calls), rubric: RUBRIC, model: "model-a", rowsDir: path.join(tree.root, "rows"), casesDir: casesPath(), runId: "r", workflowVersion: "w" };
  await scoreVideo(deps, { id, source: null, title: `Real title ${id}`, transcriptPath: path.join(tree.root, `${id}.md`), outputPath: path.join(tree.root, `${id}.score.json`), durationSeconds: 9000 });
}
const tsInvalidCard = { ...SCORED, techniques: [{ ts: "0:30", what: "real" }, { ts: "5:00", what: "invented" }] };

const run = (argv: string[], runner: ScoreRunner = totals()) => runCli(argv, (l) => out.push(l), (l) => out.push(`ERR ${l}`), runner);
const flag = (id: string, ...rest: string[]) => run(["flag", id, "--transcript", path.join(tree.root, `${id}.md`), ...rest]);
const casesPath = () => path.join(tree.root, "scout", "evals", "cases");

beforeEach(() => {
  tree = tempTree();
  out = [];
  vi.stubEnv("YT_ROOT", tree.root);
  vi.stubEnv("TITAN_YT_SCOUT_CONFIG", path.join(tree.root, "watchlist.yml"));
  vi.stubEnv("TITAN_YT_SCOUT_DB", path.join(tree.root, "state", "scout.sqlite3"));
  tree.write("watchlist.yml", VALID_WATCHLIST);
  tree.write("RUBRIC.md", RUBRIC);
});
afterEach(() => {
  vi.unstubAllEnvs();
  tree.cleanup();
});

describe("titan-yt-scout flag", () => {
  it("writes the transcript's path and sha256 and none of its text", async () => {
    seedCard("aaaaaaaaa01", 12);

    const code = await flag("aaaaaaaaa01", "--verdict", "over", "--gold-total", "8", "--note", "padded");

    expect(code).toBe(0);
    const text = readFileSync(path.join(casesPath(), "score-aaaaaaaaa01.json"), "utf8");
    const c = JSON.parse(text);
    expect(c.inputs.transcript_path).toBe(path.join(tree.root, "aaaaaaaaa01.md"));
    expect(c.inputs.transcript_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(c.gold).toEqual({ verdict: "over", total: 8, note: "padded" });
    expect(c.prompt_sha).toBe("p-sha");
    expect(text).not.toContain(SECRET);
  });

  it("refuses over, under and miss without a gold total", async () => {
    seedCard("aaaaaaaaa01", 12);

    const code = await flag("aaaaaaaaa01", "--verdict", "miss");

    expect(code).toBe(3);
    expect(readdirSync(tree.root)).not.toContain("scout");
  });

  it("adds gold to a ts_invalid case the score step filed and keeps its label and inputs", async () => {
    await scoreAutomatic("aaaaaaaaa01", tsInvalidCard, []);
    const file = path.join(casesPath(), "score-aaaaaaaaa01.json");
    const before = JSON.parse(readFileSync(file, "utf8"));

    const code = await flag("aaaaaaaaa01", "--verdict", "wrong-ts", "--note", "n");

    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ...before, gold: { verdict: "wrong-ts", note: "n" } });
  });

  it("adds gold to a schema_invalid case, which has no card file", async () => {
    await scoreAutomatic("aaaaaaaaa01", { nope: 1 }, []);

    const code = await flag("aaaaaaaaa01", "--verdict", "miss", "--gold-total", "9");

    expect(code).toBe(0);
    expect(readCases(casesPath())[0]).toMatchObject({ label: "schema_invalid", inputs: { title: "Real title aaaaaaaaa01", partial: true }, gold: { verdict: "miss", total: 9 } });
  });
});

describe("titan-yt-scout eval replay", () => {
  const opts = (runner: ScoreRunner, extra: Partial<ReplayOptions> = {}): ReplayOptions => ({
    runner,
    rubric: RUBRIC,
    model: "model-fast",
    thresholdTotal: 10,
    maxCases: Infinity,
    maxCostUsd: 2,
    ...extra,
  });

  async function seedTwoCases(): Promise<void> {
    seedCard("aaaaaaaaa01", 12);
    seedCard("aaaaaaaaa02", 8);
    await flag("aaaaaaaaa01", "--verdict", "over", "--gold-total", "11");
    await flag("aaaaaaaaa02", "--verdict", "bad-why");
  }

  it("computes agreement, mean absolute difference and cost against gold or the recorded card", async () => {
    await seedTwoCases();

    const s = await replayCases(readCases(casesPath()), opts(totals(5, 5)));

    // case 01: gold 11, replay 5 -> opposite sides, diff 6. case 02: recorded 8, replay 5 -> same side, diff 3.
    expect(s).toMatchObject({ cases: 2, replayed: 2, compared: 2, agreement: 0.5, meanAbsDiff: 4.5, tsValid: 1 });
    expect(s.costUsd).toBeCloseTo(0.06);
  });

  it("prints the three figures through the CLI", async () => {
    await seedTwoCases();

    const code = await run(["eval", "replay", "--model", "model-fast", "--rubric", path.join(tree.root, "RUBRIC.md")], totals(5, 5));

    expect(code).toBe(0);
    expect(out).toContain("agreement: 50% of 2 compared");
    expect(out).toContain("mean absolute difference: 4.50");
    expect(out).toContain("cost: $0.0600");
  });

  it("replays a case the score step filed with the original prompt, partial cut included", async () => {
    const original: ScoreCall[] = [];
    await scoreAutomatic("aaaaaaaaa01", tsInvalidCard, original);
    const replayed: ScoreCall[] = [];

    const s = await replayCases(readCases(casesPath()), opts(recording(SCORED, replayed)));

    expect(s).toMatchObject({ replayed: 1, stale: 0, compared: 1, meanAbsDiff: 0 });
    expect(replayed[0]!.prompt).toBe(original[0]!.prompt);
  });

  it("skips a case whose transcript changed since it was flagged", async () => {
    await seedTwoCases();
    tree.write("aaaaaaaaa01.md", `${TRANSCRIPT}\n[1:00] Later edit.\n`);

    const s = await replayCases(readCases(casesPath()), opts(totals(5)));

    expect(s).toMatchObject({ replayed: 1, stale: 1 });
  });

  it("stops at the case cap and at the cost cap", async () => {
    await seedTwoCases();

    const byCases = await replayCases(readCases(casesPath()), opts(totals(5, 5), { maxCases: 1 }));
    const byCost = await replayCases(readCases(casesPath()), opts(totals(5, 5), { maxCostUsd: 0.03 }));

    expect(byCases.replayed).toBe(1);
    expect(byCost.replayed).toBe(1);
  });

  it("counts a schema-invalid replay as failed and leaves it out of the metrics", async () => {
    await seedTwoCases();
    const bad: ScoreRunner = async (call) => ({ ok: true, value: { output: { nope: 1 }, costUsd: 0.01, inputTokens: 1, outputTokens: 1, model: call.model } });

    const s = await replayCases(readCases(casesPath()), opts(bad));

    expect(s).toMatchObject({ replayed: 2, failed: 2, compared: 0, agreement: null, meanAbsDiff: null });
  });
});

describe("weekly audit", () => {
  const candidates = (n: number): AuditCandidate[] =>
    Array.from({ length: n }, (_, i) => ({ id: `id${i}`, cardPath: `/x/id${i}.score.json`, transcriptPath: `/x/id${i}.md` }));

  it("picks 5 cards, the same 5 for the same seed, others for another", () => {
    const a = selectAuditSample(candidates(20), "2026-W44");

    expect(a).toHaveLength(5);
    expect(selectAuditSample(candidates(20), "2026-W44")).toEqual(a);
    expect(selectAuditSample(candidates(20), "2026-W45")).not.toEqual(a);
  });

  it("flags a gap of 3, or a side flip at a smaller gap, and nothing else", () => {
    expect(disagrees(12, 9, 10)).toBe(true);
    expect(disagrees(10, 9, 10)).toBe(true);
    expect(disagrees(12, 10, 10)).toBe(false);
    expect(disagrees(4, 7, 10)).toBe(true);
  });

  it("samples scored rows from the window, leaving out videos that already have a case", async () => {
    const row = (id: string, startedAt: string, outcome = "ok") =>
      JSON.stringify({ step: "score", video_id: id, outcome, started_at: startedAt, output_path: path.join(tree.root, `${id}.score.json`) });
    tree.write(
      "rows/steps-2026-10.jsonl",
      [row("old00000001", "2026-10-01T00:00:00Z"), row("new00000001", "2026-10-25T00:00:00Z"), row("new00000002", "2026-10-26T00:00:00Z"), row("new00000003", "2026-10-26T00:00:00Z", "fail")].join("\n"),
    );
    seedCard("new00000002", 9);
    await flag("new00000002", "--verdict", "bad-why");

    const found = auditCandidates(path.join(tree.root, "rows"), new Date("2026-10-22T00:00:00Z"), casesPath());

    expect(found.map((c) => c.id)).toEqual(["new00000001"]);
    expect(found[0]!.transcriptPath).toBe(path.join(tree.root, "new00000001.md"));
  });

  it("files an audit-disagree case only for the card the stronger model scores 3 or more away", async () => {
    seedCard("aaaaaaaaa01", 12);
    seedCard("aaaaaaaaa02", 12);
    const sample = ["aaaaaaaaa01", "aaaaaaaaa02"].map((id) => ({ id, cardPath: path.join(tree.root, `${id}.score.json`), transcriptPath: path.join(tree.root, `${id}.md`) }));

    const report = await runAudit(sample, { runner: totals(5, 5), rubric: RUBRIC, model: "model-strong", maxBudgetUsd: 0.25, thresholdTotal: 10, casesDir: casesPath() });

    expect(report).toMatchObject({ sampled: 2 });
    expect(report.filed).toHaveLength(2);
    const c = readCases(casesPath())[0]!;
    expect(c.label).toBe("audit-disagree");
    expect(JSON.stringify(c)).not.toContain(SECRET);
  });

  it("files nothing when the audit agrees", async () => {
    seedCard("aaaaaaaaa01", 5);
    const sample = [{ id: "aaaaaaaaa01", cardPath: path.join(tree.root, "aaaaaaaaa01.score.json"), transcriptPath: path.join(tree.root, "aaaaaaaaa01.md") }];

    const report = await runAudit(sample, { runner: totals(5), rubric: RUBRIC, model: "model-strong", maxBudgetUsd: 0.25, thresholdTotal: 10, casesDir: casesPath() });

    expect(report.filed).toEqual([]);
    expect(readCases(casesPath())).toEqual([]);
  });
});
