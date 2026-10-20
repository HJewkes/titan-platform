import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Command, Option } from "commander";
import { z } from "zod";
import type { EvalCliDeps } from "./eval-cli.js";
import { readRubric } from "./eval-evidence.js";
import { createJudgeHarness, JudgeConfigSchema } from "./eval-harness.js";
import { agreedFlags, itemRoutes, ITEMS_EVAL_ID, runItems, type ItemsInput, type ItemsResult } from "./eval-items.js";
import { CANARY_COLUMNS } from "./eval-judge-cli.js";
import { paceInput, type ScriptFormat } from "./eval-pace-cli.js";
import { appendRun, appendTsv, benchLayout, freezeScript, judgedRun, rulesSha, type BenchLayout, type DeterministicRun } from "./eval-store.js";
import { DEFAULT_RULES_PATH, parseRuleRegistry } from "./rules.js";
import { readTiming } from "./timing.js";

const EXIT = { OK: 0, UNTRUSTED: 1, USAGE: 2 } as const;

/** The fewest runs in which two can outvote a third. */
const ITEMS_RUNS = 3;

const RUN_KEY = ["config_id", "script_sha", "eval_id", "eval_version", "judge", "run", "chapter"] as const;
const ITEMS_SCORE_COLUMNS = [...RUN_KEY, "qid", "kind", "beat", "subject", "pass", "picked", "evidence", "void_reason"] as const;

interface ItemsFlags {
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
  input: Omit<ItemsInput, "run">;
  runs: number;
}

function prepare(file: string, flags: ItemsFlags, deps: EvalCliDeps): Prepared {
  const raw = readJson(file);
  const { beats, invariants } = paceInput(raw, flags.format, flags.timing ? readTiming(readJson(flags.timing)) : undefined);
  const registry = readFileSync(flags.rules ?? DEFAULT_RULES_PATH);
  parseRuleRegistry(registry.toString("utf8"));
  const judge = JudgeConfigSchema.parse(readJson(flags.judge));
  const runs = z.coerce.number().int().positive().parse(flags.runs);
  const bench = benchLayout(flags.bench);
  const scriptSha = freezeScript(bench, raw, flags.parent ?? null);
  const record = { configId: flags.config, scriptSha, parentSha: flags.parent ?? null, rulesSha: rulesSha(registry), evalId: ITEMS_EVAL_ID };
  const routes = itemRoutes(beats, invariants);
  const input = { scriptSha, beats, routes, rubric: readRubric("l1-items.md"), judge, harness: (deps.harness ?? createJudgeHarness)(judge) };
  return { bench, record, input, runs };
}

function writeRows(p: Prepared, result: ItemsResult, run: number): void {
  const key = (chapter: string) => ({ config_id: p.record.configId, script_sha: p.record.scriptSha, eval_id: ITEMS_EVAL_ID, eval_version: result.eval_version, judge: result.judge, run, chapter });
  const scores = result.chapters.flatMap((c) =>
    c.verdicts.map((v) => ({ ...key(c.chapter), ...v, pass: v.pass === null ? "" : String(v.pass), picked: v.picked ?? "", void_reason: v.void_reason ?? "" })),
  );
  appendTsv(join(p.bench.evals, "items-scores.tsv"), ITEMS_SCORE_COLUMNS, scores);
  appendTsv(join(p.bench.evals, "canaries.tsv"), CANARY_COLUMNS, result.chapters.map((c) => ({ ...key(c.chapter), ...c.canary })));
}

function report(p: Prepared, run: number, r: ItemsResult): void {
  const failedCanaries = r.chapters.filter((c) => !c.canary.pass).map((c) => `${c.canary.canary}=${c.canary.got}`);
  const verdicts = r.chapters.flatMap((c) => c.verdicts);
  const counts = { questions: verdicts.length, void: verdicts.filter((v) => v.pass === null).length, flagged: verdicts.filter((v) => v.pass === false).length };
  const verdict = { trusted: r.trusted, ...counts, failed_canaries: failedCanaries, failures: r.failures, usd: r.spend.usd };
  console.log(JSON.stringify({ script_sha: p.record.scriptSha, run, eval_version: r.eval_version, judge: r.judge, ...verdict }));
}

/** Each run is a fresh judge; every run's rows are kept, and the command is trusted only if all of them are. */
async function evalItems(file: string, flags: ItemsFlags, deps: EvalCliDeps): Promise<boolean> {
  const p = prepare(file, flags, deps);
  const now = deps.now ?? (() => new Date());
  const results: ItemsResult[] = [];
  for (let run = 1; run <= p.runs; run++) {
    const started = now();
    const result = await runItems({ ...p.input, run });
    const finished = now();
    writeRows(p, result, run);
    appendRun(p.bench, judgedRun({ ...p.record, evalVersion: result.eval_version, judge: result.judge, run, spend: result.spend, started, finished }));
    report(p, run, result);
    results.push(result);
  }
  console.log(JSON.stringify({ script_sha: p.record.scriptSha, agreed_flags: agreedFlags(results) }));
  return results.every((r) => r.trusted);
}

export function itemsCommand(deps: EvalCliDeps, onResult: (code: number) => void): Command {
  return new Command("items")
    .description("Judge the routed beats of a spike or script/v1 file: explained (M3), seated (M5) and odd one out; append items-scores and canaries rows")
    .argument("<script>", "script JSON file")
    .requiredOption("--judge <file>", "judge config JSON: provider (claude-print or codex), model, optional reasoning_effort, max_budget_usd, wall_time_s")
    .addOption(new Option("--format <format>", "script shape: a Python-emitted spike script.json, or strict script/v1").choices(["spike", "v1"]).default("spike"))
    .option("--timing <file>", "words.json (or a durations-only extract); heard durations replace plannedS")
    .option("--config <id>", "config_id for the rows; a spike script has no generator configuration", "unconfigured")
    .option("--rules <file>", "rules/v1 registry, by default the shipped doctrine/rules.yaml; its sha is rules_sha on the run records")
    .option("--bench <dir>", "bench directory holding evals/ and scripts/", "bench")
    .option("--parent <sha>", "script_sha this script was derived from")
    .option("--runs <n>", "independent judges; two of three must agree to flag a beat", String(ITEMS_RUNS))
    .exitOverride()
    .action(async (file: string, flags: ItemsFlags) => {
      try {
        onResult((await evalItems(file, flags, deps)) ? EXIT.OK : EXIT.UNTRUSTED);
      } catch (error) {
        console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
        onResult(EXIT.USAGE);
      }
    });
}
