import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { runImplementCases } from "./implement/cases-cli.js";
import { loadCasesV1 } from "./review/cases.js";
import { cloneGitFor, collectRepoRoot } from "./review/repos.js";
import { buildReviewSample } from "./review/sample.js";

interface CasesFlags {
  track: "r" | "i";
  source?: string;
  corpus?: string;
  out?: string;
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

const requireFlag = (value: string | undefined, name: string): string => {
  if (value === undefined) throw new Error(`track r needs ${name}`);
  return value;
};

async function writeCases(flags: CasesFlags): Promise<void> {
  const bodies = loadCasesV1(resolve(requireFlag(flags.source, "--source")), readFileSync(requireFlag(flags.corpus, "--corpus"), "utf8"));
  const counts = { defect: flags.real, planted: flags.planted, clean: flags.clean };
  const { queue, manifest } = await buildReviewSample({ bodies, gitFor: cloneGitFor(flags.repoRoot ?? {}), seed: flags.seed, counts });
  const outDir = resolve(requireFlag(flags.out, "--out"));
  mkdirSync(outDir, { recursive: true });
  const lines = queue.map(({ hash: _hash, stratum: _stratum, ...body }) => JSON.stringify(body));
  writeFileSync(join(outDir, "queue.jsonl"), lines.map((line) => `${line}\n`).join(""));
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const preview = queue.slice(0, QUEUE_PREVIEW).map((item) => `${item.caseType}/${item.kind} ${item.id}`);
  console.log(JSON.stringify({ ...manifest, queueHead: preview }, null, 2));
}

/** Everything the user typed after `cases`, less `--track i`, which the implement track's own parser does not know. */
function implementArgv(command: Command): string[] {
  let root = command;
  while (root.parent !== null) root = root.parent;
  // commander keeps the root's argv as `rawArgs` but does not type it; the implement parser needs flags verbatim.
  const raw = (root as Command & { rawArgs: string[] }).rawArgs;
  const rest = raw.slice(raw.indexOf("cases") + 1);
  const at = rest.findIndex((arg) => arg === "--track" || arg.startsWith("--track="));
  return at < 0 ? rest : rest.filter((_arg, index) => index !== at && !(rest[at] === "--track" && index === at + 1));
}

export function casesCommand(onResult: (code: number) => void): Command {
  return new Command("cases")
    .description("Build a track's sampled, stratified case queue into <out>/queue.jsonl, with counts in <out>/manifest.json")
    .addOption(new Option("--track <track>", "the track to build cases for: r (review) or i (implement, whose own flags follow)").choices(["r", "i"]).makeOptionMandatory())
    .option("--source <dir>", "the review-pr cases-v1 directory (holds cases/ and trees/)")
    .option("--corpus <file>", "the review-pr corpus.jsonl the cases' provenance refs join to")
    .option("--out <dir>", "where queue.jsonl and manifest.json go")
    .option("--repo-root <name=path>", "a local clone to read commits from, per repo name; repeatable", collectRepoRoot)
    .option("--real <n>", "real-defect cases", count, 60)
    .option("--planted <n>", "planted-defect cases: existing controls first, then new plants on dev clean heads", count, 40)
    .option("--clean <n>", "clean cases", count, 60)
    .option("--seed <text>", "seeds sampling and the queue order", "bench-2026-11")
    .allowUnknownOption()
    .allowExcessArguments()
    .exitOverride()
    .action(async (flags: CasesFlags, command: Command) => {
      try {
        if (flags.track === "i") {
          onResult(await runImplementCases(implementArgv(command)));
          return;
        }
        await writeCases(flags);
        onResult(0);
      } catch (error) {
        if (error instanceof CommanderError) throw error;
        console.error(`bench cases: ${error instanceof Error ? error.message : String(error)}`);
        onResult(1);
      }
    });
}
