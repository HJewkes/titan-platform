import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import type { EvalCliDeps } from "./eval-cli.js";
import { readRubric } from "./eval-evidence.js";
import { codexUnavailable, createJudgeHarness, JudgeConfigSchema, judgeLabel, type JudgeConfig, type JudgeHarness } from "./eval-harness.js";
import { L1_EVAL_ID, runL1, type CanaryResult, type L1Result } from "./eval-judge.js";
import { appendRun, appendTsv, benchLayout, freezeScript, judgedRun, readTsv, rulesSha, type BenchLayout } from "./eval-store.js";
import { deriveEvalView } from "./eval-view.js";
import { L2_EVAL_ID, runL2, type AnswerKeyRow, type L2Result, type ReferenceEdge } from "./eval-viewer.js";
import { MapLayoutSchema } from "./map-state.js";
import { ScriptSchema, type ScriptV1 } from "./script-schema.js";

const EXIT = { OK: 0, UNTRUSTED: 1, USAGE: 2 } as const;

const SCORE_COLUMNS = ["config_id", "script_sha", "eval_id", "eval_version", "judge", "run", "dim", "score", "evidence", "void_reason"] as const;
export const BEAT_SCORE_COLUMNS = ["config_id", "script_sha", "beat", ...SCORE_COLUMNS.slice(2)] as const;
export const SCRIPT_SCORE_COLUMNS = SCORE_COLUMNS;
export const VIEWER_COLUMNS = ["config_id", "script_sha", "eval_id", "eval_version", "track", "qid", "judge", "run", "answer", "cited_beats", "grade", "edge_f1", "void_reason"] as const;
export const CANARY_COLUMNS = ["config_id", "script_sha", "eval_id", "eval_version", "judge", "run", "canary", "dim", "got", "pass"] as const;

interface JudgedFlags {
  config: string;
  rules: string;
  judge: string;
  bench: string;
  runs: string;
  parent?: string;
  layout?: string;
  answerKey?: string;
  referenceGraph?: string;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const readJudge = (path: string): JudgeConfig => JudgeConfigSchema.parse(readJson(path));

const readAnswerKey = (path: string): AnswerKeyRow[] =>
  readTsv(path).map((row) => ({ qid: row.qid ?? "", required_terms: (row.required_terms ?? "").split(",").map((t) => t.trim()).filter(Boolean) }));
const readReferenceGraph = (path: string): ReferenceEdge[] => readTsv(path).map((row) => ({ from: row.from ?? "", to: row.to ?? "" }));

interface Prepared {
  script: ScriptV1;
  sha: string;
  rules: string;
  bench: BenchLayout;
  judge: JudgeConfig;
  harness: JudgeHarness;
  runs: number;
}

function prepare(file: string, flags: JudgedFlags, deps: EvalCliDeps): Prepared {
  const raw = readJson(file);
  const script = ScriptSchema.parse(raw);
  const bench = benchLayout(flags.bench);
  const judge = readJudge(flags.judge);
  const runs = z.coerce.number().int().positive().parse(flags.runs);
  const harness = (deps.harness ?? createJudgeHarness)(judge);
  return { script, sha: freezeScript(bench, raw, flags.parent ?? null), rules: rulesSha(readFileSync(flags.rules)), bench, judge, harness, runs };
}

type Judged = Pick<L1Result, "eval_version" | "judge" | "spend">;

function recordRun(p: Prepared, flags: JudgedFlags, evalId: string, run: number, result: Judged, started: Date, finished: Date): void {
  const { eval_version: evalVersion, judge, spend } = result;
  appendRun(p.bench, judgedRun({ configId: flags.config, scriptSha: p.sha, parentSha: flags.parent ?? null, rulesSha: p.rules, evalId, evalVersion, judge, run, spend, started, finished }));
}

const keyed = (flags: JudgedFlags, p: Prepared, evalId: string, result: Judged, run: number) =>
  ({ config_id: flags.config, script_sha: p.sha, eval_id: evalId, eval_version: result.eval_version, judge: result.judge, run });

function writeCanaries(p: Prepared, key: ReturnType<typeof keyed>, canaries: readonly CanaryResult[]): void {
  appendTsv(join(p.bench.evals, "canaries.tsv"), CANARY_COLUMNS, canaries.map((c) => ({ ...key, ...c })));
}

function writeL1(flags: JudgedFlags, p: Prepared, result: L1Result, run: number): void {
  const key = keyed(flags, p, L1_EVAL_ID, result, run);
  const cells = (v: L1Result["script"][number]["verdict"]) => ({ score: v.score ?? "", evidence: v.evidence, void_reason: v.void_reason ?? "" });
  appendTsv(join(p.bench.evals, "beat-scores.tsv"), BEAT_SCORE_COLUMNS, result.beats.map((b) => ({ ...key, beat: b.beat, dim: b.dim, ...cells(b.verdict) })));
  appendTsv(join(p.bench.evals, "script-scores.tsv"), SCRIPT_SCORE_COLUMNS, result.script.map((s) => ({ ...key, dim: s.dim, ...cells(s.verdict) })));
  writeCanaries(p, key, result.canaries);
}

function writeL2(flags: JudgedFlags, p: Prepared, result: L2Result, run: number): void {
  const key = keyed(flags, p, L2_EVAL_ID, result, run);
  const rows = result.answers.map((a) => ({ ...key, ...a, grade: a.grade ?? "", edge_f1: a.edge_f1 ?? "", void_reason: a.void_reason ?? "" }));
  appendTsv(join(p.bench.evals, "viewer.tsv"), VIEWER_COLUMNS, rows);
  writeCanaries(p, key, result.canaries);
}

type Summary = Pick<L1Result, "eval_version" | "judge" | "trusted" | "failures" | "canaries" | "spend">;

const report = (p: Prepared, run: number, r: Summary): void => {
  const failedCanaries = r.canaries.filter((c) => !c.pass).map((c) => `${c.canary}:${c.dim}=${c.got}`);
  const line = { script_sha: p.sha, run, eval_version: r.eval_version, judge: r.judge, trusted: r.trusted, failed_canaries: failedCanaries, failures: r.failures, usd: r.spend.usd };
  console.log(JSON.stringify(line));
};

async function judgeRuns<R extends Summary>(
  p: Prepared,
  flags: JudgedFlags,
  deps: EvalCliDeps,
  evalId: string,
  once: (run: number) => Promise<R>,
  write: (r: R, run: number) => void,
): Promise<boolean> {
  const now = deps.now ?? (() => new Date());
  let trusted = true;
  for (let run = 1; run <= p.runs; run++) {
    const started = now();
    const result = await once(run);
    write(result, run);
    recordRun(p, flags, evalId, run, result, started, now());
    report(p, run, result);
    trusted &&= result.trusted;
  }
  return trusted;
}

function evalL1(file: string, flags: JudgedFlags, deps: EvalCliDeps): Promise<boolean> {
  const p = prepare(file, flags, deps);
  const layout = flags.layout ? MapLayoutSchema.parse(readJson(flags.layout)) : undefined;
  const beats = deriveEvalView(p.script, layout);
  const chapters = p.script.chapters.map((c) => p.script.beats.filter((b) => b.chapter === c.id).map((b) => b.id)).filter((ids) => ids.length > 0);
  const rubrics = { beat: readRubric("l1-beat.md"), script: readRubric("l1-script.md") };
  const once = (run: number) => runL1({ scriptSha: p.sha, beats, chapters, rubrics, judge: p.judge, harness: p.harness, run });
  return judgeRuns(p, flags, deps, L1_EVAL_ID, once, (r, run) => writeL1(flags, p, r, run));
}

function evalL2(file: string, flags: JudgedFlags, deps: EvalCliDeps): Promise<boolean> {
  const p = prepare(file, flags, deps);
  const layout = flags.layout ? MapLayoutSchema.parse(readJson(flags.layout)) : undefined;
  const fixed = {
    scriptSha: p.sha,
    beats: deriveEvalView(p.script, layout),
    rubric: readRubric("l2-viewer.md"),
    judge: p.judge,
    harness: p.harness,
    ...(flags.answerKey ? { answerKey: readAnswerKey(flags.answerKey) } : {}),
    ...(flags.referenceGraph ? { referenceGraph: readReferenceGraph(flags.referenceGraph) } : {}),
  };
  return judgeRuns(p, flags, deps, L2_EVAL_ID, (run) => runL2({ ...fixed, run }), (r, run) => writeL2(flags, p, r, run));
}

type Evaluate = (file: string, flags: JudgedFlags, deps: EvalCliDeps) => Promise<boolean>;

function judgedCommand(name: string, description: string, evaluate: Evaluate, deps: EvalCliDeps, onResult: (code: number) => void): Command {
  return new Command(name)
    .description(description)
    .argument("<script>", "script/v1 JSON file")
    .requiredOption("--config <id>", "config_id of the generator configuration")
    .requiredOption("--rules <file>", "rule registry file; its sha is rules_sha on the run record")
    .requiredOption("--judge <file>", "judge config JSON: provider (claude-print or codex), model, optional reasoning_effort, max_budget_usd, wall_time_s")
    .option("--bench <dir>", "bench directory holding evals/ and scripts/", "bench")
    .option("--runs <n>", "independent runs, each on a fresh context", "1")
    .option("--parent <sha>", "script_sha this script was derived from")
    .option("--layout <file>", "map layout JSON, so a whole-level map shows its nodes")
    .exitOverride()
    .action(async (file: string, flags: JudgedFlags) => {
      try {
        onResult((await evaluate(file, flags, deps)) ? EXIT.OK : EXIT.UNTRUSTED);
      } catch (error) {
        console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
        onResult(EXIT.USAGE);
      }
    });
}

export const l1Command = (deps: EvalCliDeps, onResult: (code: number) => void): Command =>
  judgedCommand("l1", "Judge a script with the L1 beat and script rubrics; append beat-scores, script-scores and canaries rows", evalL1, deps, onResult);

export const l2Command = (deps: EvalCliDeps, onResult: (code: number) => void): Command =>
  judgedCommand("l2", "Quiz a fresh viewer on the S, SV and V tracks; append viewer and canaries rows", evalL2, deps, onResult)
    .option("--answer-key <file>", "answer-key.tsv: qid, fact_ids, required_terms")
    .option("--reference-graph <file>", "reference-graph.tsv: from, to, protocol, fact_id");

const SmokeSchema = z.strictObject({ ok: z.boolean() });

/** One tiny call through the configured judge; a codex judge this host cannot run is skipped, not failed. */
async function smoke(path: string, deps: EvalCliDeps): Promise<number> {
  const judge = readJudge(path);
  const missing = judge.provider === "codex" ? (deps.codexUnavailable ?? codexUnavailable)(judge) : null;
  if (missing) {
    console.log(JSON.stringify({ judge: judgeLabel(judge), skipped: missing }));
    return EXIT.OK;
  }
  const reply = await (deps.harness ?? createJudgeHarness)(judge)({ prompt: "Reply with ok set to true.", schema: SmokeSchema });
  console.log(JSON.stringify({ judge: judgeLabel(judge), ok: reply.ok && reply.output.ok, ...(reply.ok ? {} : { reason: reply.reason }), usd: reply.usd }));
  return reply.ok && reply.output.ok ? EXIT.OK : EXIT.UNTRUSTED;
}

export const smokeCommand = (deps: EvalCliDeps, onResult: (code: number) => void): Command =>
  new Command("smoke")
    .description("Prove the configured judge answers one schema-bound call; skips a codex judge with no binary or no login")
    .requiredOption("--judge <file>", "judge config JSON")
    .exitOverride()
    .action(async ({ judge }: { judge: string }) => {
      try {
        onResult(await smoke(judge, deps));
      } catch (error) {
        console.error(`${judge}: ${error instanceof Error ? error.message : String(error)}`);
        onResult(EXIT.USAGE);
      }
    });
