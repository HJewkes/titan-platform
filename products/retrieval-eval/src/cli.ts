import { readFileSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import { activeWorkSearch } from "./candidates/active-work-search.js";
import { defaultGraphPath, type Candidate } from "./candidates/candidate.js";
import { dateOrderNotes } from "./candidates/date-order.js";
import { hybridVector } from "./candidates/hybrid-vector.js";
import { notesFts } from "./candidates/notes-fts.js";
import { defaultTranscriptRoots, discoverTranscripts, readHead } from "./corpus/transcripts.js";
import { mineBootstrapArm } from "./mine/bootstrap-arm.js";
import { defaultActiveRoot } from "./mine/labels.js";
import { mineSpawnArm } from "./mine/spawn-arm.js";
import { formatPairs, parsePairs } from "./pairs.js";
import { QUERY_VARIANTS, type QueryVariant } from "./query/variants.js";
import { formatRows, runEval } from "./run.js";
import { snapshot } from "./snapshot.js";
import { countUptake } from "./uptake.js";

/**
 * Three verbs, matching the three parts of the harness: mine the pairs, score
 * the candidates on them, count whether anyone used a recall tool at all.
 */

interface CommonOptions {
  activeRoot: string;
  graph: string;
}

function mineCommand(): Command {
  return new Command("mine")
    .description("Mine query/label pairs from transcripts into JSONL")
    .option("--arm <arm>", "spawn | bootstrap | both", "both")
    .option("--out <file>", "write JSONL here instead of stdout")
    .option("--active-root <dir>", "active-work root", defaultActiveRoot())
    .option("--graph <file>", "session graph, read-only", defaultGraphPath())
    .action(async (options) => {
      const files = discoverTranscripts(defaultTranscriptRoots());
      const heads = await Promise.all(files.map((file) => readHead(file)));
      const report = await mine(options.arm, files, heads, options.activeRoot);
      const jsonl = formatPairs(report.pairs);
      if (options.out) writeFileSync(options.out, jsonl);
      else process.stdout.write(jsonl);
      const stamps = heads.map((head) => head.startedAt ?? "");
      console.error(JSON.stringify({ ...report.stats, snapshot: snapshot(files, options.graph, stamps) }, null, 2));
    });
}

async function mine(
  arm: string,
  files: string[],
  heads: Awaited<ReturnType<typeof readHead>>[],
  activeRoot: string,
) {
  const spawn = arm === "bootstrap" ? undefined : await mineSpawnArm(files, activeRoot);
  const bootstrap = arm === "spawn" ? undefined : await mineBootstrapArm(activeRoot, heads);
  return {
    pairs: [...(spawn?.pairs ?? []), ...(bootstrap?.pairs ?? [])],
    stats: {
      ...(spawn ? { spawnArm: { ...spawn, pairs: spawn.pairs.length } } : {}),
      ...(bootstrap ? { bootstrapArm: { ...bootstrap, pairs: bootstrap.pairs.length } } : {}),
    },
  };
}

async function buildCandidates(names: string[], common: CommonOptions): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  if (names.includes("active-work-search")) candidates.push(activeWorkSearch({ activeRoot: common.activeRoot }));
  if (names.includes("notes-fts")) candidates.push(notesFts({ graphPath: common.graph, activeRoot: common.activeRoot }));
  if (names.includes("date-order-notes")) candidates.push(dateOrderNotes({ activeRoot: common.activeRoot }));
  if (names.includes("hybrid-fts-vector")) {
    const lexical = notesFts({ graphPath: common.graph, activeRoot: common.activeRoot });
    candidates.push(await hybridVector({ activeRoot: common.activeRoot, lexical }));
  }
  return candidates;
}

const ALL_CANDIDATES = ["date-order-notes", "active-work-search", "notes-fts", "hybrid-fts-vector"];

function runCommand(): Command {
  return new Command("run")
    .description("Score candidate retrievers over a mined pair file")
    .argument("<pairs>", "JSONL produced by `mine`")
    .option("--candidates <list>", "comma-separated", ALL_CANDIDATES.join(","))
    .option("--variants <list>", "comma-separated query derivations", QUERY_VARIANTS.join(","))
    .option("--json", "emit rows as JSON instead of a table")
    .option("--active-root <dir>", "active-work root", defaultActiveRoot())
    .option("--graph <file>", "session graph, read-only", defaultGraphPath())
    .action(async (pairsFile, options) => {
      const pairs = parsePairs(readFileSync(pairsFile, "utf8"));
      const candidates = await buildCandidates(String(options.candidates).split(","), options);
      try {
        const rows = await runEval({
          pairs,
          candidates,
          variants: String(options.variants).split(",") as QueryVariant[],
          onProgress: (done, total) => process.stderr.write(`\r${done}/${total} cells`),
        });
        process.stderr.write("\n");
        console.log(options.json ? JSON.stringify(rows, null, 2) : formatRows(rows));
      } finally {
        for (const candidate of candidates) candidate.close();
      }
    });
}

function uptakeCommand(): Command {
  return new Command("uptake")
    .description("Count recall-tool calls against filesystem-search calls")
    .option("--since <iso-date>", "ignore tool calls before this date")
    .action(async (options) => {
      const files = discoverTranscripts(defaultTranscriptRoots());
      console.log(JSON.stringify(await countUptake(files, { since: options.since }), null, 2));
    });
}

export function buildCli(): Command {
  return new Command("retrieval-eval")
    .description("Transcript-mined retrieval eval harness (TP-84)")
    .addCommand(mineCommand())
    .addCommand(runCommand())
    .addCommand(uptakeCommand());
}

export async function runCli(argv: string[]): Promise<number> {
  try {
    await buildCli().parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
