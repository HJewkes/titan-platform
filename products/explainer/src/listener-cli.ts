import { readFileSync, writeFileSync } from "node:fs";
import { Command, InvalidArgumentError, Option } from "commander";
import type { EvalCliDeps } from "./eval-cli.js";
import { createJudgeHarness, JudgeConfigSchema } from "./eval-harness.js";
import { paceInput, type ScriptFormat } from "./eval-pace-cli.js";
import { listenerVerdict, runListener, type ListenerResult } from "./listener-questions.js";

const EXIT = { OK: 0, RED: 1, USAGE: 2 } as const;

interface ListenerFlags {
  judge: string;
  format: ScriptFormat;
  threshold?: number;
  out?: string;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

function threshold(text: string): number {
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) throw new InvalidArgumentError(`--threshold must be a number of questions a sentence, 0 or more, got "${text}"`);
  return value;
}

/** The run's line: counts, density and flag counts per chapter; the questions themselves go to `--out`. */
function summaryLine(result: ListenerResult, verdict: { pass: boolean; detail: string }): string {
  const chapters = Object.fromEntries(result.chapters.map((c) => [c.chapter, {
    questions: c.questions, sentences: c.sentences.length, density: Number(c.density.toFixed(2)),
    per_sentence: c.sentences.map((s) => s.questions), list_spread: c.flags.list_spread.length,
    terms_before_setup: c.flags.terms_before_setup.map((t) => t.term), fragments: c.flags.fragments, untagged: c.untagged,
  }]));
  const totals = { questions: result.questions, sentences: result.sentences, density: Number(result.density.toFixed(2)) };
  return JSON.stringify({ eval_version: result.eval_version, judge: result.judge, ...totals, chapters, pass: verdict.pass, failures: result.failures, usd: result.spend.usd });
}

async function evalListener(file: string, flags: ListenerFlags, deps: EvalCliDeps): Promise<boolean> {
  const { beats } = paceInput(readJson(file), flags.format, undefined);
  const judge = JudgeConfigSchema.parse(readJson(flags.judge));
  const result = await runListener({ beats, judge, harness: (deps.harness ?? createJudgeHarness)(judge) });
  if (flags.out) writeFileSync(flags.out, `${JSON.stringify(result, null, 2)}\n`);
  const verdict = listenerVerdict(result, flags.threshold);
  console.log(summaryLine(result, verdict));
  return verdict.pass;
}

export function listenerCommand(deps: EvalCliDeps, onResult: (code: number) => void): Command {
  return new Command("listener")
    .description("The owner's listener exercise: a fresh listener hears each chapter once and lists every question it leaves unanswered, by sentence")
    .argument("<script>", "script JSON file")
    .requiredOption("--judge <file>", "judge config JSON: provider (claude-print or codex), model, optional reasoning_effort, max_budget_usd, wall_time_s")
    .addOption(new Option("--format <format>", "script shape: a Python-emitted spike script.json, or strict script/v1").choices(["spike", "v1"]).default("spike"))
    .option("--threshold <q>", "questions a sentence above which a chapter is red (default: none, the verdict is reported only)", threshold)
    .option("--out <file>", "write the whole result, every question with its sentence, as JSON")
    .exitOverride()
    .action(async (file: string, flags: ListenerFlags) => {
      try {
        onResult((await evalListener(file, flags, deps)) ? EXIT.OK : EXIT.RED);
      } catch (error) {
        console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
        onResult(EXIT.USAGE);
      }
    });
}
