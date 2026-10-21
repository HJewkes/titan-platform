import { readFileSync } from "node:fs";
import { appDirs } from "@titan-design/app-paths";
import type { Command } from "commander";
import { QuerySpecSchema } from "../types.js";
import type { Answer } from "./answer.js";
import { ask, resume, type AskResult, type HostOptions } from "./host.js";

type Write = (line: string) => void;

interface AskFlags {
  corpus: string;
  index?: string;
  rules?: string;
  spec?: string;
  screenModel: string;
  confirmModel: string;
  concurrency: string;
  rounds: string;
  budgetUsd: string;
}

/** Ctrl-C stops the drive and releases the run, so `resume` can pick it up without waiting out the lease. */
export function defaultHost(): HostOptions {
  const interrupt = new AbortController();
  process.once("SIGINT", () => interrupt.abort());
  return { dataDir: appDirs("corpus-query").data, signal: interrupt.signal };
}

function summary(answer: Answer): string {
  const { screen, confirm } = answer.coverage;
  return [
    `rounds ${answer.rounds}, candidates ${answer.candidates}, rows ${answer.rows.length}`,
    `screen: passages ${screen.retrieved}, judged ${screen.judged}, voided ${screen.voided}, unjudged ${screen.unjudged.length}, skipped ${screen.skipped.length}, canary misses ${screen.canaries.misses}/${screen.canaries.batches}`,
    `confirm: passages ${confirm.retrieved}, judged ${confirm.judged}, voided ${confirm.voided}, unjudged ${confirm.unjudged.length}, skipped ${confirm.skipped.length}`,
  ].join("\n");
}

function report(result: AskResult, write: Write): void {
  if (result.compileRunId) write(`compile run ${result.compileRunId}`);
  write(`answer run ${result.runId}: ${result.status}`);
  if (result.status === "running") write(`interrupted; continue with: corpus-query resume ${result.runId}`);
  if (result.answer) write(summary(result.answer));
}

export function addAskCommand(program: Command, write: Write, host: () => HostOptions, indexFor: (root: string) => string): void {
  program
    .command("ask <question>")
    .description("Answer a 'list every X' question over an indexed corpus with verified judge calls")
    .requiredOption("--corpus <root>", "corpus root the index was built from")
    .option("--index <file>", "index database built by `corpus-query index` (default: per-user data dir)")
    .option("--rules <file>", "owner rulings, copied verbatim into the judge prefix")
    .option("--spec <file>", "a compiled spec to reuse instead of compiling the question")
    .option("--screen-model <model>", "screening model", "haiku")
    .option("--confirm-model <model>", "confirming model", "sonnet")
    .option("--concurrency <n>", "judge calls in flight at once", "4")
    .option("--rounds <n>", "grow rounds after the first screen", "2")
    .option("--budget-usd <usd>", "stop launching judge calls past this spend", "3")
    .action(async (question: string, flags: AskFlags) => {
      const result = await ask({
        question, corpus: flags.corpus, index: flags.index ?? indexFor(flags.corpus),
        ...(flags.rules ? { rules: readFileSync(flags.rules, "utf8") } : {}),
        ...(flags.spec ? { spec: QuerySpecSchema.parse(JSON.parse(readFileSync(flags.spec, "utf8"))) } : {}),
        models: { screen: flags.screenModel, confirm: flags.confirmModel },
        concurrency: Number(flags.concurrency), rounds: Number(flags.rounds), budgetUsd: Number(flags.budgetUsd),
      }, host());
      report(result, write);
    });
}

export function addResumeCommand(program: Command, write: Write, host: () => HostOptions): void {
  program
    .command("resume <runId>")
    .description("Drive a crashed answer run on; finished batches are not paid for again")
    .action(async (runId: string) => report(await resume(runId, host()), write));
}
