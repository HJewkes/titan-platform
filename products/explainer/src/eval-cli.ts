import { readFileSync } from "node:fs";
import { Command, CommanderError } from "commander";
import { l0HardPass, runL0, type L0Check } from "./eval-l0.js";
import { appendRun, appendTsv, benchLayout, freezeScript, rulesSha, STRUCTURE_COLUMNS, type RunRecord, type StructureRow } from "./eval-store.js";
import { MapLayoutSchema } from "./map-state.js";
import { ScriptSchema } from "./script-schema.js";

const EXIT = { OK: 0, FAILURE: 1, USAGE: 2 } as const;

export const L0_EVAL_ID = "L0-script";

interface L0Flags {
  config: string;
  rules: string;
  bench: string;
  parent?: string;
  layout?: string;
}

/** The clock and check list are injectable so a run is reproducible in a test. */
export interface EvalCliDeps {
  now?: () => Date;
  checks?: readonly L0Check[];
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

/** L0 has no rubric, so its eval_version is the registry it ran under. */
const l0Run = (flags: L0Flags, sha: string, rules: string, started: Date, finished: Date): RunRecord => ({
  config_id: flags.config,
  script_sha: sha,
  parent_sha: flags.parent ?? null,
  rules_sha: rules,
  eval_id: L0_EVAL_ID,
  eval_version: rules,
  judge: null,
  run: 0,
  batch_id: null,
  usd: 0,
  tokens_in: 0,
  tokens_out: 0,
  wall_s: (finished.getTime() - started.getTime()) / 1000,
  started_at: started.toISOString(),
});

/** Scores one script, appends its rows and run record, and returns whether it passed the hard filter. */
function evalL0(file: string, flags: L0Flags, deps: EvalCliDeps): boolean {
  const now = deps.now ?? (() => new Date());
  const started = now();
  const raw = readJson(file);
  const script = ScriptSchema.parse(raw);
  const layout = flags.layout ? MapLayoutSchema.parse(readJson(flags.layout)) : undefined;
  const bench = benchLayout(flags.bench);
  const rules = rulesSha(readFileSync(flags.rules));
  const sha = freezeScript(bench, raw, flags.parent ?? null);
  const results = runL0(script, layout, deps.checks);
  const rows: StructureRow[] = results.map((result) => ({ config_id: flags.config, script_sha: sha, rules_sha: rules, ...result }));
  appendTsv(bench.structure, STRUCTURE_COLUMNS, rows);
  appendRun(bench, l0Run(flags, sha, rules, started, now()));
  const pass = l0HardPass(results);
  const failed = results.filter((r) => !r.pass).map((r) => `${r.check_id}${r.severity === "warning" ? " (warning)" : ""}`);
  console.log(JSON.stringify({ script_sha: sha, rules_sha: rules, pass, checks: results.length, failed }));
  return pass;
}

function l0Command(deps: EvalCliDeps, onResult: (code: number) => void): Command {
  return new Command("l0")
    .description("Run the deterministic L0 checks on a script/v1 file; append structure.tsv rows and a runs.jsonl record")
    .argument("<script>", "script/v1 JSON file")
    .requiredOption("--config <id>", "config_id of the generator configuration, e.g. tour-short/script-v1-02")
    .requiredOption("--rules <file>", "rule registry file; its sha is rules_sha on every row")
    .option("--bench <dir>", "bench directory holding evals/ and scripts/", "bench")
    .option("--parent <sha>", "script_sha this script was derived from")
    .option("--layout <file>", "map layout JSON; without it the map lints are skipped")
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

/** Exit 0 when the script passes, 1 when an error-severity check fails, 2 on bad input or usage. */
export async function runEvalCli(argv: readonly string[], deps: EvalCliDeps = {}): Promise<number> {
  let code: number = EXIT.OK;
  const onResult = (next: number): void => {
    code = next;
  };
  const evalCommand = new Command("eval").description("Score scripts against the eval harness").exitOverride().addCommand(l0Command(deps, onResult));
  const program = new Command("explainer").exitOverride().addCommand(evalCommand);
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? EXIT.OK : EXIT.USAGE;
    throw error;
  }
  return code;
}
