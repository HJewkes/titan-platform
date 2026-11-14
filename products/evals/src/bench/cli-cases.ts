import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { loadCasesV1 } from "./review/cases.js";
import { cloneGitFor, collectRepoRoot } from "./review/repos.js";
import { buildReviewSample } from "./review/sample.js";

interface CasesFlags {
  track: "r";
  source: string;
  corpus: string;
  out: string;
  repoRoot?: Record<string, string>;
  real: number;
  planted: number;
  clean: number;
  seed: string;
}

const count = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new InvalidArgumentError("expected a whole number");
  return parsed;
};

const QUEUE_PREVIEW = 10;

async function writeCases(flags: CasesFlags): Promise<void> {
  const bodies = loadCasesV1(resolve(flags.source), readFileSync(flags.corpus, "utf8"));
  const counts = { defect: flags.real, planted: flags.planted, clean: flags.clean };
  const { queue, manifest } = await buildReviewSample({ bodies, gitFor: cloneGitFor(flags.repoRoot ?? {}), seed: flags.seed, counts });
  const outDir = resolve(flags.out);
  mkdirSync(outDir, { recursive: true });
  const lines = queue.map(({ hash: _hash, stratum: _stratum, ...body }) => JSON.stringify(body));
  writeFileSync(join(outDir, "queue.jsonl"), lines.map((line) => `${line}\n`).join(""));
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const preview = queue.slice(0, QUEUE_PREVIEW).map((item) => `${item.caseType}/${item.kind} ${item.id}`);
  console.log(JSON.stringify({ ...manifest, queueHead: preview }, null, 2));
}

export function casesCommand(onResult: (code: number) => void): Command {
  return new Command("cases")
    .description("Build a track's sampled, stratified case queue into <out>/queue.jsonl, with counts in <out>/manifest.json")
    .addOption(new Option("--track <track>", "the track to build cases for (only r so far)").choices(["r"]).makeOptionMandatory())
    .requiredOption("--source <dir>", "the review-pr cases-v1 directory (holds cases/ and trees/)")
    .requiredOption("--corpus <file>", "the review-pr corpus.jsonl the cases' provenance refs join to")
    .requiredOption("--out <dir>", "where queue.jsonl and manifest.json go")
    .option("--repo-root <name=path>", "a local clone to read commits from, per repo name; repeatable", collectRepoRoot)
    .option("--real <n>", "real-defect cases", count, 60)
    .option("--planted <n>", "planted-defect cases: existing controls first, then new plants on dev clean heads", count, 40)
    .option("--clean <n>", "clean cases", count, 60)
    .option("--seed <text>", "seeds sampling and the queue order", "bench-2026-11")
    .exitOverride()
    .action(async (flags: CasesFlags) => {
      try {
        await writeCases(flags);
        onResult(0);
      } catch (error) {
        if (error instanceof CommanderError) throw error;
        console.error(`bench cases: ${error instanceof Error ? error.message : String(error)}`);
        onResult(1);
      }
    });
}
