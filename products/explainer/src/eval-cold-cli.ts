import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Command, Option } from "commander";
import { z } from "zod";
import type { EvalCliDeps } from "./eval-cli.js";
import { agreedOddOnes, COLD_EVAL_ID, runCold, type ColdInput, type ColdResult } from "./eval-cold.js";
import { readRubric } from "./eval-evidence.js";
import { createJudgeHarness, JudgeConfigSchema } from "./eval-harness.js";
import { CANARY_COLUMNS } from "./eval-judge-cli.js";
import { paceBeats, type ScriptFormat } from "./eval-pace-cli.js";
import { appendRun, appendTsv, benchLayout, freezeScript, judgedRun, rulesSha, type BenchLayout, type DeterministicRun } from "./eval-store.js";
import { DEFAULT_RULES_PATH, parseRuleRegistry } from "./rules.js";
import { readTiming } from "./timing.js";

const EXIT = { OK: 0, UNTRUSTED: 1, USAGE: 2 } as const;

/** The fewest runs in which two can outvote a third, the odd-one-out quorum. */
export const COLD_RUNS = 3;

const RUN_KEY = ["config_id", "script_sha", "eval_id", "eval_version", "judge", "run", "chapter"] as const;
export const COLD_SCORE_COLUMNS = [...RUN_KEY, "qid", "kind", "beat", "item", "score", "void_reason"] as const;
export const COLD_CHAPTER_COLUMNS = [...RUN_KEY, "minutes", "undefined_items", "undefined_per_minute", "summary"] as const;

interface ColdFlags {
  judge: string;
  format: ScriptFormat;
  timing?: string;
  config: string;
  rules?: string;
  bench: string;
  parent?: string;
  runs: string;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

interface Prepared {
  bench: BenchLayout;
  record: Omit<DeterministicRun, "started" | "finished">;
  input: Omit<ColdInput, "run">;
  runs: number;
}

function prepare(file: string, flags: ColdFlags, deps: EvalCliDeps): Prepared {
  const raw = readJson(file);
  const beats = paceBeats(raw, flags.format, flags.timing ? readTiming(readJson(flags.timing)) : undefined);
  const registry = readFileSync(flags.rules ?? DEFAULT_RULES_PATH);
  parseRuleRegistry(registry.toString("utf8"));
  const judge = JudgeConfigSchema.parse(readJson(flags.judge));
  const runs = z.coerce.number().int().positive().parse(flags.runs);
  const bench = benchLayout(flags.bench);
  const scriptSha = freezeScript(bench, raw, flags.parent ?? null);
  const record = { configId: flags.config, scriptSha, parentSha: flags.parent ?? null, rulesSha: rulesSha(registry), evalId: COLD_EVAL_ID };
  const input = { scriptSha, beats, rubric: readRubric("l1-cold.md"), judge, harness: (deps.harness ?? createJudgeHarness)(judge) };
  return { bench, record, input, runs };
}

function writeRows(p: Prepared, result: ColdResult, run: number): void {
  const key = (chapter: string) => ({ config_id: p.record.configId, script_sha: p.record.scriptSha, eval_id: COLD_EVAL_ID, eval_version: result.eval_version, judge: result.judge, run, chapter });
  const scores = result.chapters.flatMap((c) => [
    ...c.scores.map((s) => ({ ...key(c.chapter), qid: s.qid, kind: s.kind, beat: s.beat, item: s.item, score: String(s.score), void_reason: s.void_reason ?? "" })),
    ...c.odd_one_out.map((o) => ({ ...key(c.chapter), qid: o.qid, kind: "odd-one-out", beat: o.beat, item: o.picked ?? "", score: "", void_reason: "" })),
  ]);
  appendTsv(join(p.bench.evals, "cold-scores.tsv"), COLD_SCORE_COLUMNS, scores);
  appendTsv(join(p.bench.evals, "cold-chapters.tsv"), COLD_CHAPTER_COLUMNS, result.chapters.map((c) => ({ ...key(c.chapter), ...c })));
  // canaries.tsv is shared with l1 and l2, so it keeps their columns; the relay label names the chapter's canary.
  appendTsv(join(p.bench.evals, "canaries.tsv"), CANARY_COLUMNS, result.chapters.map((c) => ({ ...key(c.chapter), ...c.canary })));
}

function report(p: Prepared, run: number, r: ColdResult): void {
  const perMinute = Object.fromEntries(r.chapters.map((c) => [c.chapter, Number(c.undefined_per_minute.toFixed(2))]));
  const failedCanaries = r.chapters.filter((c) => !c.canary.pass).map((c) => `${c.canary.canary}=${c.canary.got}`);
  const line = { script_sha: p.record.scriptSha, run, eval_version: r.eval_version, judge: r.judge, trusted: r.trusted, undefined_per_minute: perMinute, failed_canaries: failedCanaries, failures: r.failures, usd: r.spend.usd };
  console.log(JSON.stringify(line));
}

/** Each run is a fresh viewer; every run's rows are kept, and the command is trusted only if all of them are. */
async function evalCold(file: string, flags: ColdFlags, deps: EvalCliDeps): Promise<boolean> {
  const p = prepare(file, flags, deps);
  const now = deps.now ?? (() => new Date());
  const results: ColdResult[] = [];
  for (let run = 1; run <= p.runs; run++) {
    const started = now();
    const result = await runCold({ ...p.input, run });
    const finished = now();
    writeRows(p, result, run);
    appendRun(p.bench, judgedRun({ ...p.record, evalVersion: result.eval_version, judge: result.judge, run, spend: result.spend, started, finished }));
    report(p, run, result);
    results.push(result);
  }
  console.log(JSON.stringify({ script_sha: p.record.scriptSha, agreed_odd_ones: agreedOddOnes(results) }));
  return results.every((r) => r.trusted);
}

export function coldCommand(deps: EvalCliDeps, onResult: (code: number) => void): Command {
  return new Command("cold")
    .description("Stream a spike or script/v1 file to a fresh cold viewer chapter by chapter; append cold-scores, cold-chapters and canaries rows")
    .argument("<script>", "script JSON file")
    .requiredOption("--judge <file>", "judge config JSON: provider (claude-print or codex), model, optional reasoning_effort, max_budget_usd, wall_time_s")
    .addOption(new Option("--format <format>", "script shape: a Python-emitted spike script.json, or strict script/v1").choices(["spike", "v1"]).default("spike"))
    .option("--timing <file>", "words.json (or a durations-only extract); heard durations and word times replace plannedS")
    .option("--config <id>", "config_id for the rows; a spike script has no generator configuration", "unconfigured")
    .option("--rules <file>", "rules/v1 registry, by default the shipped doctrine/rules.yaml; its sha is rules_sha on the run records")
    .option("--bench <dir>", "bench directory holding evals/ and scripts/", "bench")
    .option("--parent <sha>", "script_sha this script was derived from")
    .option("--runs <n>", "independent cold viewers; two of three must agree to flag an odd one out", String(COLD_RUNS))
    .exitOverride()
    .action(async (file: string, flags: ColdFlags) => {
      try {
        onResult((await evalCold(file, flags, deps)) ? EXIT.OK : EXIT.UNTRUSTED);
      } catch (error) {
        console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
        onResult(EXIT.USAGE);
      }
    });
}
