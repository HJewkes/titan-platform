import { readFileSync } from "node:fs";
import { Command, CommanderError } from "commander";
import { calibrateCommand } from "./eval-calibrate-cli.js";
import { coldCommand } from "./eval-cold-cli.js";
import { failedChecks, l0HardPass, runL0, type L0Check, type L0Result } from "./eval-l0.js";
import type { JudgeConfig, JudgeHarness } from "./eval-harness.js";
import { itemsCommand } from "./eval-items-cli.js";
import { l1Command, l2Command, smokeCommand } from "./eval-judge-cli.js";
import { paceCommand } from "./eval-pace-cli.js";
import { appendRun, appendTsv, benchLayout, deterministicRun, freezeScript, rulesSha, STRUCTURE_COLUMNS, type StructureRow } from "./eval-store.js";
import { MapLayoutSchema } from "./map-state.js";
import { DEFAULT_RULES_PATH, parseRuleRegistry, unimplementedL0Rules, type RuleRegistry } from "./rules.js";
import { ScriptSchema } from "./script-schema.js";
import { readTiming } from "./timing.js";

const EXIT = { OK: 0, FAILURE: 1, USAGE: 2 } as const;

export const L0_EVAL_ID = "L0-script";

interface L0Flags {
  config: string;
  rules?: string;
  bench: string;
  parent?: string;
  layout?: string;
  timing?: string;
  failOnGhosts?: boolean;
}

/** The clock, check list and judge harness are injectable so a run is reproducible in a test. */
export interface EvalCliDeps {
  now?: () => Date;
  checks?: readonly L0Check[];
  harness?: (config: JudgeConfig) => JudgeHarness;
  codexUnavailable?: (config: JudgeConfig) => string | null | Promise<string | null>;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

/**
 * Check ids a rule claims that no run check emitted, one string per rule and id. The map lints
 * emit nothing without a layout, so their ids are not ghosts in a layout-free run.
 */
function ghostCheckIds(registry: RuleRegistry, results: readonly L0Result[], hasLayout: boolean): string[] {
  const emitted = new Set(results.map((result) => result.check_id));
  const claimed = new Map(registry.rules.map((rule) => [rule.id, rule.l0?.status === "implemented" ? rule.l0.checks : (rule.l0?.partial ?? [])]));
  const known = (id: string): boolean => emitted.has(id) || (!hasLayout && id.startsWith("map:"));
  return unimplementedL0Rules(registry, new Set([...emitted, ...[...claimed.values()].flat().filter(known)])).flatMap((ruleId) =>
    [...new Set((claimed.get(ruleId) ?? []).filter((id) => !known(id)))].map((id) => `${ruleId}: claimed check id ${id} is never emitted`),
  );
}

/** Scores one script, appends its rows and run record, and returns whether it passed the hard filter. */
function evalL0(file: string, flags: L0Flags, deps: EvalCliDeps): boolean {
  const now = deps.now ?? (() => new Date());
  const started = now();
  const raw = readJson(file);
  const script = ScriptSchema.parse(raw);
  const layout = flags.layout ? MapLayoutSchema.parse(readJson(flags.layout)) : undefined;
  const bench = benchLayout(flags.bench);
  const registry = readFileSync(flags.rules ?? DEFAULT_RULES_PATH);
  const parsed = parseRuleRegistry(registry.toString("utf8"));
  const rules = rulesSha(registry);
  const timing = flags.timing ? readTiming(readJson(flags.timing)) : undefined;
  const sha = freezeScript(bench, raw, flags.parent ?? null);
  const results = runL0(script, layout, deps.checks, timing);
  const rows: StructureRow[] = results.map((result) => ({ config_id: flags.config, script_sha: sha, rules_sha: rules, ...result }));
  appendTsv(bench.structure, STRUCTURE_COLUMNS, rows);
  appendRun(bench, deterministicRun({ configId: flags.config, scriptSha: sha, parentSha: flags.parent ?? null, rulesSha: rules, evalId: L0_EVAL_ID, started, finished: now() }));
  const pass = l0HardPass(results);
  console.log(JSON.stringify({ script_sha: sha, rules_sha: rules, pass, checks: results.length, failed: failedChecks(results) }));
  const ghosts = ghostCheckIds(parsed, results, layout !== undefined);
  ghosts.forEach((ghost) => console.error(`warning: ghost L0 check: ${ghost}`));
  return pass && !(flags.failOnGhosts && ghosts.length > 0);
}

function l0Command(deps: EvalCliDeps, onResult: (code: number) => void): Command {
  return new Command("l0")
    .description("Run the deterministic L0 checks on a script/v1 file; append structure.tsv rows and a runs.jsonl record")
    .argument("<script>", "script/v1 JSON file")
    .requiredOption("--config <id>", "config_id of the generator configuration, e.g. tour-short/script-v1-02")
    .option("--rules <file>", "rules/v1 registry, by default the shipped doctrine/rules.yaml; its sha is rules_sha on every row")
    .option("--bench <dir>", "bench directory holding evals/ and scripts/", "bench")
    .option("--parent <sha>", "script_sha this script was derived from")
    .option("--layout <file>", "map layout JSON; without it the map lints are skipped")
    .option("--timing <file>", "words.json (or a durations-only extract); the pace lints read its heard durations, not plannedS")
    .option("--fail-on-ghosts", "exit 1 when a rule claims a check id that no L0 check emits; by default each is a warning")
    .exitOverride()
    .action((file: string, flags: L0Flags) => {
      try {
        onResult(evalL0(file, flags, deps) ? EXIT.OK : EXIT.FAILURE);
      } catch (error) {
        console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
        onResult(EXIT.USAGE);
      }
    });
}

/**
 * Exit 0 when the script passes (l0, pace) or the run is trusted (l1, l2, cold), 1 when an error-severity check
 * fails or a canary or judge call fails, 2 on bad input or usage.
 */
export async function runEvalCli(argv: readonly string[], deps: EvalCliDeps = {}): Promise<number> {
  let code: number = EXIT.OK;
  const onResult = (next: number): void => {
    code = next;
  };
  const evalCommand = new Command("eval").description("Score scripts against the eval harness").exitOverride()
    .addCommand(l0Command(deps, onResult))
    .addCommand(paceCommand(deps, onResult))
    .addCommand(l1Command(deps, onResult))
    .addCommand(l2Command(deps, onResult))
    .addCommand(coldCommand(deps, onResult))
    .addCommand(itemsCommand(deps, onResult))
    .addCommand(smokeCommand(deps, onResult))
    .addCommand(calibrateCommand(onResult));
  const program = new Command("explainer").exitOverride().addCommand(evalCommand);
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? EXIT.OK : EXIT.USAGE;
    throw error;
  }
  return code;
}
