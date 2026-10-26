import { readFileSync, writeFileSync } from "node:fs";
import { Command, CommanderError, Option } from "commander";
import { z } from "zod";
import { createJudgeHarness, JudgeConfigSchema, type JudgeCall, type JudgeConfig, type JudgeHarness, type JudgeReply } from "./eval-harness.js";
import { sentencesOf } from "./lint-text.js";
import { MAX_SENTENCE_WORDS, needsSpeechVet, type SpeechVerdict } from "./lint-voice.js";
import { migrateSpike } from "./migrate.js";
import { l0Scorer, measureRewrite } from "./rewrite-measure-run.js";
import { rewriteScript, type ChapterVerdict, type RewriteReport, type RewriteResult } from "./rewrite-pass.js";
import { MAX_REWRITE_ROUNDS } from "./rewrite-plan.js";
import { ScriptSchema, type ScriptV1 } from "./script-schema.js";
import { verdictSummary, type SentenceVerdict, type SentenceVet } from "./speech-vet-gate.js";
import { localSentenceVet } from "./speech-vet-local.js";

const EXIT = { OK: 0, RED: 1, USAGE: 2 } as const;

const SCRIPT_FORMATS = ["v1", "spike"] as const;
type ScriptFormat = (typeof SCRIPT_FORMATS)[number];

interface RewriteFlags {
  judge: string;
  out: string;
  format: ScriptFormat;
  rounds: string;
  speechVet?: boolean;
  report?: string;
}

/** The model harness, the sentence vetter and the output streams are injectable so a run needs no model in a test. */
export interface RewriteCliDeps {
  harness?: (config: JudgeConfig) => JudgeHarness;
  /** Builds the sentence vetter `--speech-vet` uses; by default speech-vet over local Kokoro and Whisper. */
  speechVet?: () => Promise<SentenceVet>;
  out?: (text: string) => void;
  err?: (text: string) => void;
  /** Replaces the whole pass in `rewrite measure`, so a measure runs on canned results. */
  rewriteRun?: (script: ScriptV1) => Promise<RewriteResult>;
}

type Io = Required<Pick<RewriteCliDeps, "out" | "err">>;

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface VerdictCache {
  speechClean: SpeechVerdict;
  vet: (lines: readonly string[]) => Promise<void>;
  verdicts: () => SentenceVerdict[];
}

/**
 * The guard asks for a verdict synchronously, so each sentence of 26 to 32 words is vetted before the guard sees it
 * and its verdict kept. Vets run one at a time since each loads speech models; a vet that throws is not clean.
 */
function verdictCache(vetSentence: SentenceVet): VerdictCache {
  const verdicts = new Map<string, SentenceVerdict>();
  let queue = Promise.resolve();
  const vetNow = async (lines: readonly string[]): Promise<void> => {
    const pending = [...new Set(lines.flatMap(sentencesOf))].filter((sentence) => needsSpeechVet(sentence) && !verdicts.has(sentence));
    for (const sentence of pending) {
      const status = await vetSentence(sentence).then((result) => result.status, (error: unknown) => `error: ${errorText(error)}`);
      verdicts.set(sentence, { sentence, status, clean: status === "accepted" });
    }
  };
  return {
    speechClean: (sentence) => verdicts.get(sentence)?.clean === true,
    vet: (lines) => (queue = queue.then(() => vetNow(lines))),
    verdicts: () => [...verdicts.values()],
  };
}

const RepliedLinesSchema = z.object({ beats: z.array(z.object({ spoken: z.string() })) });

/** Vets the long sentences of each reply before the pass guards it. */
function vettingHarness(harness: JudgeHarness, cache: VerdictCache): JudgeHarness {
  return async <T>(call: JudgeCall<T>): Promise<JudgeReply<T>> => {
    const reply = await harness(call);
    const lines = reply.ok ? RepliedLinesSchema.safeParse(reply.output) : undefined;
    if (lines?.success) await cache.vet(lines.data.beats.map((beat) => beat.spoken));
    return reply;
  };
}

/** Under `--speech-vet`, a cache holding the input's verdicts; undefined when the flag is off or no vetter can be built. */
async function speechCache(script: ScriptV1, speechVet: boolean, deps: RewriteCliDeps, io: Io): Promise<VerdictCache | undefined> {
  if (!speechVet) return undefined;
  let vetSentence: SentenceVet;
  try {
    vetSentence = await (deps.speechVet ?? localSentenceVet)();
  } catch (error) {
    io.err(`speech-vet: unavailable (${errorText(error)}); sentences keep the ${MAX_SENTENCE_WORDS}-word cap\n`);
    return undefined;
  }
  const cache = verdictCache(vetSentence);
  await cache.vet(script.beats.map((beat) => beat.spoken));
  return cache;
}

const rounded = (value: number): number => Number(value.toFixed(3));

const chapterLine = ({ chapter, kept, why, rows }: ChapterVerdict) => ({ chapter, kept, ...(why ? { why } : {}), ...(rows ? { rows } : {}) });

/** One stdout line: each target row before and after, what each round did, and the spend. */
function summary(out: string, report: RewriteReport) {
  const before = new Map(report.before.map((row) => [row.check_id, row]));
  return {
    out,
    judge: report.judge,
    pass: report.after.every((row) => row.pass),
    rows: report.after.map(({ check_id, value, pass }) => ({ check_id, before: rounded(before.get(check_id)?.value ?? NaN), after: rounded(value), pass })),
    rounds: report.rounds.map(({ round, kept, rewritten, rejected, reverted, chapters }) =>
      ({ round, kept, rewritten: rewritten.length, rejected: rejected.length, reverted: reverted.length, chapters: chapters.map(chapterLine) })),
    calls: report.calls.length,
    failed_calls: report.calls.filter((call) => !call.ok).length,
    usd: report.usd,
  };
}

/** Reads a script/v1 file, or a spike script migrated to script/v1. */
function readScript(file: string, format: ScriptFormat): ScriptV1 {
  const raw = readJson(file);
  return format === "spike" ? migrateSpike(raw) : ScriptSchema.parse(raw);
}

const readJudge = (file: string): JudgeConfig => JudgeConfigSchema.parse(readJson(file));
const parseRounds = (rounds: string): number => z.coerce.number().int().min(1).max(MAX_REWRITE_ROUNDS).parse(rounds);

interface PassOptions {
  judge: JudgeConfig;
  rounds: number;
  speechVet: boolean;
}

/** One rewrite pass over a parsed script, vetting long sentences first under `speechVet`. */
async function runPass(script: ScriptV1, options: PassOptions, deps: RewriteCliDeps, io: Io): Promise<RewriteResult> {
  const harness = (deps.harness ?? createJudgeHarness)(options.judge);
  const cache = await speechCache(script, options.speechVet, deps, io);
  const speech = cache ? { harness: vettingHarness(harness, cache), speechClean: cache.speechClean } : { harness };
  const result = await rewriteScript(script, { judge: options.judge, rounds: options.rounds, ...speech });
  if (cache) io.err(`${verdictSummary(cache.verdicts())}\n`);
  return result;
}

async function rewrite(file: string, flags: RewriteFlags, deps: RewriteCliDeps, io: Io): Promise<number> {
  const options = { judge: readJudge(flags.judge), rounds: parseRounds(flags.rounds), speechVet: flags.speechVet === true };
  const { script: rewritten, report } = await runPass(readScript(file, flags.format), options, deps, io);
  writeFileSync(flags.out, `${JSON.stringify(rewritten, null, 2)}\n`);
  if (flags.report) writeFileSync(flags.report, `${JSON.stringify(report, null, 2)}\n`);
  const line = summary(flags.out, report);
  io.out(`${JSON.stringify(line)}\n`);
  return line.pass ? EXIT.OK : EXIT.RED;
}

interface MeasureFlags extends Omit<RewriteFlags, "out" | "report"> {
  outDir: string;
  samples: string;
  maxUsd?: string;
  reportOnly: string[];
}

/** Builds the vetter once, so each sample reuses the loaded speech models. */
function sharedVetter(deps: RewriteCliDeps): RewriteCliDeps {
  let built: Promise<SentenceVet> | undefined;
  return { ...deps, speechVet: () => (built ??= (deps.speechVet ?? localSentenceVet)()) };
}

async function measure(files: string[], flags: MeasureFlags, deps: RewriteCliDeps, io: Io): Promise<number> {
  const options = { judge: readJudge(flags.judge), rounds: parseRounds(flags.rounds), speechVet: flags.speechVet === true };
  const shared = sharedVetter(deps);
  return measureRewrite(files, {
    outDir: flags.outDir,
    samples: z.coerce.number().int().min(1).parse(flags.samples),
    ...(flags.maxUsd === undefined ? {} : { maxUsd: z.coerce.number().positive().parse(flags.maxUsd) }),
    reportOnly: new Set(flags.reportOnly),
  }, {
    read: (file) => readScript(file, flags.format),
    run: deps.rewriteRun ?? ((script) => runPass(script, options, shared, io)),
    score: l0Scorer(options.speechVet ? shared.speechVet : undefined, io.err),
    ...io,
  });
}

const collect = (value: string, previous: string[]): string[] => [...previous, value];

function measureCommand(deps: RewriteCliDeps, io: Io, onResult: (code: number) => void): Command {
  return new Command("measure")
    .description("Run the rewrite n times per input, score each output with L0, and report each target row's mean, sd and n against the revised done-when")
    .argument("<scripts...>", "script/v1 JSON files (or spike scripts with --format spike); each file's name, less its extensions, names the input")
    .requiredOption("--judge <file>", "model config JSON, as for rewrite")
    .requiredOption("--out-dir <dir>", "where each run's rewrite, report and L0 JSON, measure.json and table.md are written; a run already there is reused")
    .option("--samples <n>", "rewrites per input", "3")
    .addOption(new Option("--format <format>", "input format, as for rewrite").choices(SCRIPT_FORMATS).default("v1"))
    .option("--rounds <n>", `rewrite rounds, 1 to ${MAX_REWRITE_ROUNDS}`, String(MAX_REWRITE_ROUNDS))
    .option("--speech-vet", "vet 26-32 word sentences with speech-vet, as for rewrite")
    .option("--max-usd <usd>", "spend cap: stop before a run whose cost, estimated as the dearest run so far, would pass it")
    .option("--report-only <input:row>", "a cell that counts toward its row's mean but need not move closer, e.g. some-input:register:numbers; repeatable", collect, [])
    .exitOverride()
    .action(async (files: string[], flags: MeasureFlags) => {
      try {
        onResult(await measure(files, flags, deps, io));
      } catch (error) {
        io.err(`measure: ${errorText(error)}\n`);
        onResult(EXIT.USAGE);
      }
    });
}

function rewriteCommand(deps: RewriteCliDeps, io: Io, onResult: (code: number) => void): Command {
  return new Command("rewrite")
    .description("Rewrite spoken lines toward the Q-V11 register bands, one model call per chapter a round; write the script/v1 result (see also `rewrite measure --help`)")
    .argument("<script>", "script/v1 JSON file (or a spike script with --format spike)")
    .requiredOption("--judge <file>", "model config JSON: provider (claude-print or codex), model, optional reasoning_effort, max_budget_usd, wall_time_s")
    .requiredOption("--out <file>", "where the rewritten script/v1 JSON is written")
    .addOption(new Option("--format <format>", "input format: script/v1, or a motion-spike script.json migrated to script/v1 first").choices(SCRIPT_FORMATS).default("v1"))
    .option("--rounds <n>", `rewrite rounds, 1 to ${MAX_REWRITE_ROUNDS}`, String(MAX_REWRITE_ROUNDS))
    .option("--speech-vet", "vet each 26-32 word sentence with speech-vet (local Kokoro and Whisper) so the pass may keep it; off by default, which keeps the 25-word cap")
    .option("--report <file>", "where the full rewrite report JSON is written: rows, rounds, rejections, reverts and each call's spend")
    .exitOverride()
    .action(async (file: string, flags: RewriteFlags) => {
      try {
        onResult(await rewrite(file, flags, deps, io));
      } catch (error) {
        io.err(`${file}: ${errorText(error)}\n`);
        onResult(EXIT.USAGE);
      }
    });
}

/**
 * `explainer rewrite <script> --judge <cfg> --out <file>`: exit 0 when the rewrite is written and every target row
 * passes, 1 when it is written but a target row is still red, 2 on usage or an input that does not parse.
 */
export async function runRewriteCli(argv: readonly string[], deps: RewriteCliDeps = {}): Promise<number> {
  const io: Io = { out: deps.out ?? ((text) => process.stdout.write(text)), err: deps.err ?? ((text) => process.stderr.write(text)) };
  let code: number = EXIT.OK;
  const program = new Command("explainer").exitOverride().configureOutput({ writeOut: io.out, writeErr: io.err });
  const onResult = (next: number): void => {
    code = next;
  };
  // A subcommand would inherit rewrite's required --judge and --out checks, so measure gets its own rewrite node.
  const measuring = argv[0] === "rewrite" && argv[1] === "measure";
  program.addCommand(measuring ? new Command("rewrite").addCommand(measureCommand(deps, io, onResult)) : rewriteCommand(deps, io, onResult));
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    code = error.exitCode === 0 ? EXIT.OK : EXIT.USAGE;
  }
  return code;
}
