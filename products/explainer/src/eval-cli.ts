import { readFileSync } from "node:fs";
import { Command, CommanderError, Option } from "commander";
import { calibrateCommand } from "./eval-calibrate-cli.js";
import { coldCommand } from "./eval-cold-cli.js";
import { failedChecks, L0_CHECKS, l0HardPass, runL0, type L0Check, type L0Result } from "./eval-l0.js";
import type { JudgeConfig, JudgeHarness } from "./eval-harness.js";
import { itemsCommand } from "./eval-items-cli.js";
import { listenerCommand } from "./listener-cli.js";
import { l1Command, l2Command, smokeCommand } from "./eval-judge-cli.js";
import { paceCommand } from "./eval-pace-cli.js";
import { appendRun, appendTsv, benchLayout, deterministicRun, freezeScript, rulesSha, STRUCTURE_COLUMNS, type StructureRow } from "./eval-store.js";
import { migrateSpike } from "./migrate.js";
import { skippedSpineChecks } from "./lint-spine.js";
import { MAX_SENTENCE_WORDS, vettableSentences } from "./lint-voice.js";
import { MapLayoutSchema } from "./map-state.js";
import { DEFAULT_RULES_PATH, parseRuleRegistry, unimplementedL0Rules, type RuleRegistry } from "./rules.js";
import { parseScript } from "./script-load.js";
import type { ScriptV1 } from "./script-schema.js";
import { parseSpine } from "./spine-schema.js";
import { claimFacts, withClaimFacts } from "./claim-facts.js";
import { parseCoverage, withCoverage } from "./lint-coverage.js";
import { speechVerdict, verdictSummary, VETTED_RANGE, vetSentences, withSpeechVerdict, type SentenceVet } from "./speech-vet-gate.js";
import { localSentenceVet } from "./speech-vet-local.js";
import { readTiming } from "./timing.js";
import { writingCalibrateCommand } from "./writing-calibrate-cli.js";

const EXIT = { OK: 0, FAILURE: 1, USAGE: 2 } as const;

export const L0_EVAL_ID = "L0-script";

interface L0Flags {
  config: string;
  rules?: string;
  bench: string;
  parent?: string;
  layout?: string;
  timing?: string;
  spine?: string;
  facts?: string;
  coverage?: string;
  failOnGhosts?: boolean;
  speechVet?: boolean;
  format: ScriptFormat;
}

const SCRIPT_FORMATS = ["v1", "spike"] as const;
type ScriptFormat = (typeof SCRIPT_FORMATS)[number];

/** The clock, check list and judge harness are injectable so a run is reproducible in a test. */
export interface EvalCliDeps {
  now?: () => Date;
  checks?: readonly L0Check[];
  harness?: (config: JudgeConfig) => JudgeHarness;
  codexUnavailable?: (config: JudgeConfig) => string | null | Promise<string | null>;
  /** Builds the sentence vetter `--speech-vet` uses; by default speech-vet over local Kokoro and Whisper. */
  speechVet?: () => Promise<SentenceVet>;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

/**
 * Check ids a rule claims that no run check emitted, one string per rule and id. The map lints
 * emit nothing without a layout, and a spine lint nothing without a spine or for a structure it does not cover, so those
 * ids are not ghosts in such a run.
 */
function ghostCheckIds(registry: RuleRegistry, results: readonly L0Result[], skipped: { layout: boolean; spine: ReadonlySet<string> }): string[] {
  const emitted = new Set(results.map((result) => result.check_id));
  const claimed = new Map(registry.rules.map((rule) => [rule.id, rule.l0?.status === "implemented" ? rule.l0.checks : (rule.l0?.partial ?? [])]));
  const known = (id: string): boolean => emitted.has(id) || (skipped.layout && id.startsWith("map:")) || skipped.spine.has(id);
  return unimplementedL0Rules(registry, new Set([...emitted, ...[...claimed.values()].flat().filter(known)])).flatMap((ruleId) =>
    [...new Set((claimed.get(ruleId) ?? []).filter((id) => !known(id)))].map((id) => `${ruleId}: claimed check id ${id} is never emitted`),
  );
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The L0 checks, with Q-V9 reading speech-vet verdicts under `--speech-vet`. Without the flag, or when no vetter
 * can be built, a sentence over 25 words keeps the 25-word cap, and one stderr line says so.
 */
async function l0Checks(script: ScriptV1, flags: L0Flags, deps: EvalCliDeps): Promise<readonly L0Check[]> {
  const checks = deps.checks ?? L0_CHECKS;
  const pending = vettableSentences(script.beats).length;
  if (pending === 0) return checks;
  const capped = `${pending} sentence(s) of ${VETTED_RANGE} words keep the ${MAX_SENTENCE_WORDS}-word Q-V9 cap`;
  if (!flags.speechVet) {
    console.error(`speech-vet: off; ${capped} (pass --speech-vet to vet them)`);
    return checks;
  }
  let vetSentence: SentenceVet;
  try {
    vetSentence = await (deps.speechVet ?? localSentenceVet)();
  } catch (error) {
    console.error(`speech-vet: unavailable (${errorText(error)}); ${capped}`);
    return checks;
  }
  const verdicts = await vetSentences(script, vetSentence);
  console.error(verdictSummary(verdicts));
  return withSpeechVerdict(checks, speechVerdict(verdicts));
}

/** Scores one script, appends its rows and run record, and returns whether it passed the hard filter. */
async function evalL0(file: string, flags: L0Flags, deps: EvalCliDeps): Promise<boolean> {
  const now = deps.now ?? (() => new Date());
  const started = now();
  const raw = readJson(file);
  const script = flags.format === "spike" ? migrateSpike(raw) : parseScript(raw);
  const layout = flags.layout ? MapLayoutSchema.parse(readJson(flags.layout)) : undefined;
  const bench = benchLayout(flags.bench);
  const registry = readFileSync(flags.rules ?? DEFAULT_RULES_PATH);
  const parsed = parseRuleRegistry(registry.toString("utf8"));
  const rules = rulesSha(registry);
  const timing = flags.timing ? readTiming(readJson(flags.timing)) : undefined;
  const spine = flags.spine ? parseSpine(readFileSync(flags.spine, "utf8")) : undefined;
  const sha = freezeScript(bench, raw, flags.parent ?? null);
  const facts = flags.facts ? claimFacts(readFileSync(flags.facts, "utf8")) : undefined;
  const coverage = flags.coverage ? parseCoverage(readFileSync(flags.coverage, "utf8")) : undefined;
  const checks = withCoverage(withClaimFacts(await l0Checks(script, flags, deps), facts), coverage, facts);
  const results = runL0(script, layout, checks, timing, spine);
  const rows: StructureRow[] = results.map((result) => ({ config_id: flags.config, script_sha: sha, rules_sha: rules, ...result }));
  appendTsv(bench.structure, STRUCTURE_COLUMNS, rows);
  appendRun(bench, deterministicRun({ configId: flags.config, scriptSha: sha, parentSha: flags.parent ?? null, rulesSha: rules, evalId: L0_EVAL_ID, started, finished: now() }));
  const pass = l0HardPass(results);
  console.log(JSON.stringify({ script_sha: sha, rules_sha: rules, pass, checks: results.length, failed: failedChecks(results) }));
  const ghosts = ghostCheckIds(parsed, results, { layout: layout === undefined, spine: skippedSpineChecks(script, spine !== undefined) });
  ghosts.forEach((ghost) => console.error(`warning: ghost L0 check: ${ghost}`));
  return pass && !(flags.failOnGhosts && ghosts.length > 0);
}

function l0Command(deps: EvalCliDeps, onResult: (code: number) => void): Command {
  return new Command("l0")
    .description("Run the deterministic L0 checks on a script/v1 file (or a spike script with --format spike); append structure.tsv rows and a runs.jsonl record")
    .argument("<script>", "script/v1 JSON file")
    .requiredOption("--config <id>", "config_id of the generator configuration, e.g. tour-short/script-v1-02")
    .option("--rules <file>", "rules/v1 registry, by default the shipped doctrine/rules.yaml; its sha is rules_sha on every row")
    .option("--bench <dir>", "bench directory holding evals/ and scripts/", "bench")
    .option("--parent <sha>", "script_sha this script was derived from")
    .option("--layout <file>", "map layout JSON; without it the map lints are skipped")
    .option("--timing <file>", "words.json (or a durations-only extract); the pace lints read its heard durations, not plannedS")
    .option("--spine <file>", "story spine markdown (the script-method template); the spine lints Q-E15 and Q-E18 and the ledger lints read it")
    .option("--facts <file>", "the gather's digest.json or facts pack (facts.md or facts.jsonl); without it Q-E20 reports that it did not run")
    .option("--coverage <file>", "the daily gather's coverage.json; without it Q-E21 reports that it did not run")
    .addOption(new Option("--format <format>", "script format: a script/v1 file, or a motion-spike script.json migrated to script/v1 first").choices(SCRIPT_FORMATS).default("v1"))
    .option("--fail-on-ghosts", "exit 1 when a rule claims a check id that no L0 check emits; by default each is a warning")
    .option("--speech-vet", "vet each 26-32 word sentence with speech-vet (local Kokoro and Whisper; the first run downloads them) so Q-V9 can pass it; off by default, which keeps the 25-word cap")
    .exitOverride()
    .action(async (file: string, flags: L0Flags) => {
      try {
        onResult((await evalL0(file, flags, deps)) ? EXIT.OK : EXIT.FAILURE);
      } catch (error) {
        console.error(`${file}: ${errorText(error)}`);
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
  // Positional at every level, or a parent option such as calibrate's --format takes a subcommand's same-named flag.
  const evalCommand = new Command("eval").description("Score scripts against the eval harness").exitOverride().enablePositionalOptions()
    .addCommand(l0Command(deps, onResult))
    .addCommand(paceCommand(deps, onResult))
    .addCommand(l1Command(deps, onResult))
    .addCommand(l2Command(deps, onResult))
    .addCommand(coldCommand(deps, onResult))
    .addCommand(itemsCommand(deps, onResult))
    .addCommand(listenerCommand(deps, onResult))
    .addCommand(smokeCommand(deps, onResult))
    .addCommand(calibrateCommand(onResult))
    .addCommand(writingCalibrateCommand(onResult));
  const program = new Command("explainer").exitOverride().enablePositionalOptions().addCommand(evalCommand);
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? EXIT.OK : EXIT.USAGE;
    throw error;
  }
  return code;
}
