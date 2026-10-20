import { readFileSync } from "node:fs";
import { Command, Option } from "commander";
import { failedChecks, l0HardPass } from "./eval-l0.js";
import { appendRun, appendTsv, benchLayout, deterministicRun, freezeScript, rulesSha, STRUCTURE_COLUMNS, type StructureRow } from "./eval-store.js";
import { chapterPace, paceRows, reuseFindings, tooFast, type ChapterPace, type ReuseFinding } from "./lint-pace.js";
import { fromScriptV1, type PaceBeat } from "./pace-items.js";
import { DEFAULT_RULES_PATH, parseRuleRegistry } from "./rules.js";
import { ScriptSchema } from "./script-schema.js";
import { fromSpikeScript } from "./spike-script.js";
import { readTiming, type ScriptTiming } from "./timing.js";

const EXIT = { OK: 0, FAILURE: 1, USAGE: 2 } as const;

const PACE_EVAL_ID = "L0-pace";

export type ScriptFormat = "spike" | "v1";

interface PaceFlags {
  format: ScriptFormat;
  timing?: string;
  config: string;
  rules?: string;
  bench: string;
  parent?: string;
}

interface PaceCliDeps {
  now?: () => Date;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

interface PaceInput {
  beats: PaceBeat[];
  invariants: string[];
  glossary: string[];
}

/** The item track, the stated invariants and the glossary names of a spike or script/v1 file, so pace and the cold probe read a script the same way. */
export function paceInput(raw: unknown, format: ScriptFormat, timing: ScriptTiming | undefined): PaceInput {
  if (format === "v1") {
    const script = ScriptSchema.parse(raw);
    return { beats: fromScriptV1(script, timing), invariants: script.video.invariants ?? [], glossary: script.video.glossary.map((g) => g.name) };
  }
  const { beats, invariants, glossary, ignored } = fromSpikeScript(raw, timing);
  if (ignored.length > 0) console.error(`note: the spike reader skipped ${ignored.join(", ")}`);
  return { beats, invariants, glossary };
}

/** The item track alone of a spike or script/v1 file. */
export const paceBeats = (raw: unknown, format: ScriptFormat, timing: ScriptTiming | undefined): PaceBeat[] => paceInput(raw, format, timing).beats;

/** One line a reused beat that fails a beat-level check: the beat, the checks and heard seconds to re-voice it. */
function formatReuse(findings: readonly ReuseFinding[]): string {
  const rows = findings.map((f) => [f.beat, f.checks.join(","), f.revoiceS.toFixed(1)].join("\t"));
  return ["beat\tchecks\trevoice_s", ...rows].join("\n");
}

/** One line a chapter: its new items, heard (or planned) seconds, items a minute and the M7 verdict. */
function formatChapterPace(chapters: readonly ChapterPace[]): string {
  const header = ["chapter", "new_items", "seconds", "per_minute", "M7"];
  const rows = chapters.map((c) => [c.chapter, c.newItems, c.seconds.toFixed(1), c.perMinute.toFixed(1), tooFast(c) ? "fail" : "pass"].join("\t"));
  return [header.join("\t"), ...rows].join("\n");
}

// Only the pace lints run: the other L0 checks read script/v1 fields a spike script lacks, so they would pass it
// vacuously.
function evalPace(file: string, flags: PaceFlags, deps: PaceCliDeps): boolean {
  const now = deps.now ?? (() => new Date());
  const started = now();
  const raw = readJson(file);
  const { beats, invariants } = paceInput(raw, flags.format, flags.timing ? readTiming(readJson(flags.timing)) : undefined);
  const results = paceRows(beats, invariants);
  const registry = readFileSync(flags.rules ?? DEFAULT_RULES_PATH);
  parseRuleRegistry(registry.toString("utf8"));
  const rules = rulesSha(registry);
  const bench = benchLayout(flags.bench);
  const sha = freezeScript(bench, raw, flags.parent ?? null);
  const rows: StructureRow[] = results.map((result) => ({ config_id: flags.config, script_sha: sha, rules_sha: rules, ...result }));
  appendTsv(bench.structure, STRUCTURE_COLUMNS, rows);
  appendRun(bench, deterministicRun({ configId: flags.config, scriptSha: sha, parentSha: flags.parent ?? null, rulesSha: rules, evalId: PACE_EVAL_ID, started, finished: now() }));
  const pass = l0HardPass(results);
  console.log(formatChapterPace(chapterPace(beats)));
  const reused = reuseFindings(beats, results);
  if (reused.length > 0) console.log(formatReuse(reused));
  console.log(JSON.stringify({ script_sha: sha, rules_sha: rules, pass, checks: results.length, failed: failedChecks(results) }));
  return pass;
}

export function paceCommand(deps: PaceCliDeps, onResult: (code: number) => void): Command {
  return new Command("pace")
    .description("Run only the pace lints (M1, M2, M4, M7, M5, M9, M3) on a spike or script/v1 file; append structure.tsv rows, print items a minute per chapter and the reused beats to re-voice")
    .argument("<script>", "script JSON file")
    .addOption(new Option("--format <format>", "script shape: a Python-emitted spike script.json, or strict script/v1").choices(["spike", "v1"]).default("spike"))
    .option("--timing <file>", "words.json (or a durations-only extract); heard durations replace plannedS")
    .option("--config <id>", "config_id for the rows; a spike script has no generator configuration", "unconfigured")
    .option("--rules <file>", "rules/v1 registry, by default the shipped doctrine/rules.yaml; its sha is rules_sha on every row")
    .option("--bench <dir>", "bench directory holding evals/ and scripts/", "bench")
    .option("--parent <sha>", "script_sha this script was derived from")
    .exitOverride()
    .action((file: string, flags: PaceFlags) => {
      try {
        onResult(evalPace(file, flags, deps) ? EXIT.OK : EXIT.FAILURE);
      } catch (error) {
        console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
        onResult(EXIT.USAGE);
      }
    });
}
