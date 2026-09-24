import { readFileSync, writeFileSync } from "node:fs";
import { instantiateEmbedder } from "@titan-design/embed";
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
import { formatServed } from "./served/format.js";
import { buildReport, collectServed } from "./served/report.js";
import { snapshot } from "./snapshot.js";
import { countUptake } from "./uptake.js";

/**
 * Four verbs: mine the pairs, score the candidates on them, count whether
 * anyone used a recall tool at all, and label what the renderers actually served.
 */

interface CommonOptions {
  activeRoot: string;
  graph: string;
  embedder: string;
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
  // Baseline first, so the row everything else has to beat is the row above them.
  if (names.includes("date-order-notes")) candidates.push(dateOrderNotes({ activeRoot: common.activeRoot }));
  if (names.includes("active-work-search")) candidates.push(activeWorkSearch({ activeRoot: common.activeRoot }));
  if (names.includes("notes-fts")) candidates.push(notesFts({ graphPath: common.graph, activeRoot: common.activeRoot }));
  if (names.includes("hybrid-fts-vector")) {
    const lexical = notesFts({ graphPath: common.graph, activeRoot: common.activeRoot });
    const embedder = hybridEmbedder(common.embedder);
    candidates.push(await hybridVector({ activeRoot: common.activeRoot, lexical, embedder }));
  }
  return candidates;
}

function hybridEmbedder(backend: string) {
  if (backend === "hash" || backend === "ollama") return instantiateEmbedder({ backend });
  throw new Error(`--embedder must be hash or ollama, got ${backend}`);
}

const ALL_CANDIDATES = ["date-order-notes", "active-work-search", "notes-fts", "hybrid-fts-vector"];

function runCommand(): Command {
  return new Command("run")
    .description("Score candidate retrievers over a mined pair file")
    .argument("<pairs>", "JSONL produced by `mine`")
    .option("--candidates <list>", "comma-separated", ALL_CANDIDATES.join(","))
    .option("--variants <list>", "comma-separated query derivations", QUERY_VARIANTS.join(","))
    .option("--embedder <backend>", "hybrid-fts-vector's embedder: hash | ollama", "hash")
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

function servedCommand(): Command {
  return new Command("served")
    .description("Label what rendered bootstrap and spawn blocks served: opened, cited, and the unserved base rate")
    .option("--since <iso-date>", "only blocks rendered at or after this instant")
    .option("--until <iso-date>", "only blocks rendered before this instant; later activity is ignored")
    .option("--files <n>", "rows in the per-file table", "20")
    .option("--json", "emit the full report as JSON")
    .option("--active-root <dir>", "active-work root, read-only", defaultActiveRoot())
    .action(async (options) => {
      const files = discoverTranscripts(defaultTranscriptRoots());
      const window = { ...(options.since ? { since: options.since } : {}), ...(options.until ? { until: options.until } : {}) };
      const report = buildReport(await collectServed(files, options.activeRoot, window), window, files.length);
      console.log(options.json ? JSON.stringify(report, null, 2) : formatServed(report, Number(options.files)));
    });
}

export function buildCli(): Command {
  return new Command("retrieval-eval")
    .description("Transcript-mined retrieval eval harness (TP-84)")
    .addCommand(mineCommand())
    .addCommand(runCommand())
    .addCommand(uptakeCommand())
    .addCommand(servedCommand());
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
