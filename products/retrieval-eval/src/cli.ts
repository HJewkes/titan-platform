import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { activeWorkGraphPath, activeWorkRoot, appDirs, type PathOptions } from "@titan-design/app-paths";
import { instantiateEmbedder, LocalEmbedder, type Embedder } from "@titan-design/embed";
import { Command } from "commander";
import { activeWorkSearch } from "./candidates/active-work-search.js";
import type { Candidate } from "./candidates/candidate.js";
import { dateOrderNotes } from "./candidates/date-order.js";
import { hybridVector } from "./candidates/hybrid-vector.js";
import { notesFts } from "./candidates/notes-fts.js";
import { claimRecall, parseChunks, parseQuestions, type ArmRecall, type ArmSpec } from "./claims/recall.js";
import { readHead, transcriptFiles } from "./corpus/transcripts.js";
import { mineBootstrapArm } from "./mine/bootstrap-arm.js";
import { mineSpawnArm } from "./mine/spawn-arm.js";
import { formatPairs, parsePairs, type EvalPair } from "./pairs.js";
import { MUTATIONS } from "./query/mutate.js";
import { QUERY_VARIANTS } from "./query/variants.js";
import { formatRows, runEval, type RunRow } from "./run.js";
import { freezeSet, isSetDir, loadSet, type SetStamp } from "./set.js";
import { formatServed } from "./served/format.js";
import { buildReport, collectServed } from "./served/report.js";
import { snapshot } from "./snapshot.js";
import { countUptake } from "./uptake.js";
import { isoWeekWindow, writeWeekly } from "./weekly.js";

/**
 * Five verbs: mine the pairs, score the candidates on them, count whether
 * anyone used a recall tool at all, label what the renderers actually served,
 * and record one dated row of the last two per week.
 */

interface CommonOptions {
  activeRoot: string;
  graph: string;
  embedder: string;
}

const ARMS = ["spawn", "bootstrap", "both"] as const;
type Arm = (typeof ARMS)[number];

function parseChoice<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match !== undefined) return match;
  throw new Error(`${flag} must be one of ${allowed.join(", ")}, got ${value}`);
}

function parseChoices<T extends string>(flag: string, list: string, allowed: readonly T[]): T[] {
  return list.split(",").map((value) => parseChoice(flag, value, allowed));
}

function mineCommand(paths: PathOptions): Command {
  return new Command("mine")
    .description("Mine query/label pairs from transcripts into JSONL")
    .option("--arm <arm>", "spawn | bootstrap | both", "both")
    .option("--out <file>", "write JSONL here instead of stdout")
    .option("--active-root <dir>", "active-work root", activeWorkRoot(paths))
    .option("--graph <file>", "session graph, read-only", activeWorkGraphPath(paths))
    .action(async (options) => {
      const arm = parseChoice("--arm", options.arm, ARMS);
      const files = await transcriptFiles();
      const heads = await Promise.all(files.map((file) => readHead(file)));
      const report = await mine(arm, files, heads, options.activeRoot);
      const jsonl = formatPairs(report.pairs);
      if (options.out) writeFileSync(options.out, jsonl);
      else process.stdout.write(jsonl);
      const stamps = heads.map((head) => head.startedAt ?? "");
      console.error(JSON.stringify({ ...report.stats, snapshot: snapshot(files, options.graph, stamps) }, null, 2));
    });
}

async function mine(
  arm: Arm,
  files: string[],
  heads: Awaited<ReturnType<typeof readHead>>[],
  activeRoot: string,
) {
  const spawn = arm === "bootstrap" ? undefined : await mineSpawnArm(files, activeRoot, heads);
  const bootstrap = arm === "spawn" ? undefined : await mineBootstrapArm(activeRoot, heads);
  return {
    pairs: [...(spawn?.pairs ?? []), ...(bootstrap?.pairs ?? [])],
    stats: {
      ...(spawn ? { spawnArm: { ...spawn, pairs: spawn.pairs.length } } : {}),
      ...(bootstrap ? { bootstrapArm: { ...bootstrap, pairs: bootstrap.pairs.length } } : {}),
    },
  };
}

async function buildCandidates(names: readonly string[], common: CommonOptions): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  // Baseline first, so the row everything else has to beat is the row above them.
  if (names.includes("date-order-notes")) candidates.push(dateOrderNotes({ activeRoot: common.activeRoot }));
  if (names.includes("active-work-search")) candidates.push(activeWorkSearch({ activeRoot: common.activeRoot }));
  if (names.includes("notes-fts")) candidates.push(notesFts({ graphPath: common.graph, activeRoot: common.activeRoot }));
  if (names.includes("hybrid-fts-vector")) {
    const lexical = notesFts({ graphPath: common.graph, activeRoot: common.activeRoot });
    const embedder = hybridEmbedder(parseChoice("--embedder", common.embedder, EMBEDDERS));
    candidates.push(await hybridVector({ activeRoot: common.activeRoot, lexical, embedder }));
  }
  if (names.includes("hybrid-bge-small")) {
    const lexical = notesFts({ graphPath: common.graph, activeRoot: common.activeRoot });
    const embedder = hybridEmbedder("local");
    candidates.push(await hybridVector({ activeRoot: common.activeRoot, lexical, embedder, name: "hybrid-bge-small" }));
  }
  return candidates;
}

const EMBEDDERS = ["hash", "ollama", "local"] as const;
const BGE_SMALL_MODEL = "Xenova/bge-small-en-v1.5";

function hybridEmbedder(backend: (typeof EMBEDDERS)[number]): Embedder {
  if (backend === "local") return new LocalEmbedder({ model: BGE_SMALL_MODEL });
  return instantiateEmbedder({ backend });
}

const ALL_CANDIDATES = ["date-order-notes", "active-work-search", "notes-fts", "hybrid-fts-vector", "hybrid-bge-small"] as const;

function loadPairs(target: string): { pairs: EvalPair[]; stamp?: SetStamp } {
  if (isSetDir(target)) return loadSet(target);
  return { pairs: parsePairs(readFileSync(target, "utf8")) };
}

function printRows(rows: RunRow[], stamp: SetStamp | undefined, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(stamp ? rows.map((row) => ({ ...row, set: stamp })) : rows, null, 2));
    return;
  }
  if (stamp) process.stderr.write(`set ${stamp.id} (${stamp.pairs} pairs)\n`);
  console.log(formatRows(rows));
}

function freezeCommand(paths: PathOptions): Command {
  return new Command("freeze")
    .description("Pin a mined pair file as a set: deduplicated, sorted, with a hash-named manifest")
    .argument("<pairs>", "JSONL produced by `mine`")
    .requiredOption("--out <dir>", "directory to write pairs.jsonl and manifest.json into")
    .option("--graph <file>", "session graph, read-only", activeWorkGraphPath(paths))
    .action(async (pairsFile, options) => {
      const files = await transcriptFiles();
      const heads = await Promise.all(files.map((file) => readHead(file)));
      const stamps = heads.map((head) => head.startedAt ?? "");
      const manifest = freezeSet(readFileSync(pairsFile, "utf8"), options.out, snapshot(files, options.graph, stamps));
      console.log(JSON.stringify({ id: manifest.id, pairCounts: manifest.pairCounts }));
    });
}

function parseRunChoices(options: Record<string, unknown>) {
  const names = parseChoices("--candidates", String(options.candidates), ALL_CANDIDATES);
  const variants = parseChoices("--variants", String(options.variants), QUERY_VARIANTS);
  const mutations = parseChoices("--mutations", String(options.mutations), MUTATIONS);
  parseChoice("--embedder", String(options.embedder), EMBEDDERS);
  return { names, variants, mutations };
}

function runCommand(paths: PathOptions): Command {
  return new Command("run")
    .description("Score candidate retrievers over a mined pair file or a frozen set directory")
    .argument("<pairs>", "JSONL produced by `mine`, or a directory written by `freeze`")
    .option("--candidates <list>", "comma-separated", ALL_CANDIDATES.join(","))
    .option("--variants <list>", "comma-separated query derivations", QUERY_VARIANTS.join(","))
    .option("--mutations <list>", "comma-separated typo mutations of the rarest query term", "none")
    .option("--embedder <backend>", "hybrid-fts-vector's embedder: hash | ollama | local", "hash")
    .option("--json", "emit rows as JSON instead of a table")
    .option("--active-root <dir>", "active-work root", activeWorkRoot(paths))
    .option("--graph <file>", "session graph, read-only", activeWorkGraphPath(paths))
    .action(async (pairsFile, options) => {
      const { names, variants, mutations } = parseRunChoices(options);
      const { pairs, stamp } = loadPairs(pairsFile);
      const candidates = await buildCandidates(names, options);
      try {
        const rows = await runEval({
          pairs,
          candidates,
          variants,
          mutations,
          onProgress: (done, total) => process.stderr.write(`\r${done}/${total} cells`),
        });
        process.stderr.write("\n");
        printRows(rows, stamp, Boolean(options.json));
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
      const files = await transcriptFiles();
      console.log(JSON.stringify(await countUptake(files, { since: options.since }), null, 2));
    });
}

function servedCommand(paths: PathOptions): Command {
  return new Command("served")
    .description("Label what rendered bootstrap and spawn blocks served: opened, cited, and the unserved base rate")
    .option("--since <iso-date>", "only blocks rendered at or after this instant")
    .option("--until <iso-date>", "only blocks rendered before this instant; later activity is ignored")
    .option("--files <n>", "rows in the per-file table", "20")
    .option("--json", "emit the full report as JSON")
    .option("--active-root <dir>", "active-work root, read-only", activeWorkRoot(paths))
    .action(async (options) => {
      const files = await transcriptFiles();
      const window = { ...(options.since ? { since: options.since } : {}), ...(options.until ? { until: options.until } : {}) };
      const report = buildReport(await collectServed(files, options.activeRoot, window), window, files.length);
      console.log(options.json ? JSON.stringify(report, null, 2) : formatServed(report, Number(options.files)));
    });
}

function weeklyCommand(paths: PathOptions): Command {
  return new Command("weekly")
    .description("Write one measurement row for an ISO week: served opened ratios and recall-tool uptake")
    .requiredOption("--week <YYYY-Www>", "ISO week, Monday to Monday in UTC")
    .option("--out <file>", "weekly series JSONL", path.join(appDirs("retrieval-eval", paths).data, "weekly.jsonl"))
    .option("--active-root <dir>", "active-work root, read-only", activeWorkRoot(paths))
    .action(async (options) => {
      isoWeekWindow(options.week);
      const files = await transcriptFiles();
      const row = await writeWeekly({ week: options.week, out: options.out, files, activeRoot: options.activeRoot });
      console.log(JSON.stringify(row));
    });
}

const CLAIM_ARMS = ["fts", "fts+hash", "fts+ollama"] as const;

function claimArm(name: (typeof CLAIM_ARMS)[number]): ArmSpec {
  if (name === "fts") return { name };
  return { name, embedder: instantiateEmbedder({ backend: name === "fts+hash" ? "hash" : "ollama" }) };
}

function parseBudget(value: string): number {
  const budget = Number(value);
  if (!Number.isInteger(budget) || budget <= 0) throw new Error(`--budget must be a positive integer, got ${value}`);
  return budget;
}

function formatClaimRows(rows: ArmRecall[]): string {
  const header = ["arm", "meanRecall", "usedTokens", "questions", "excludedClaims"].join("\t");
  const lines = rows.map((row) =>
    [row.arm, row.meanRecall.toFixed(3), row.usedTokens.toFixed(1), row.questionsScored, row.claimsExcluded].join("\t"),
  );
  return [header, ...lines].join("\n");
}

function claimsCommand(): Command {
  return new Command("claims")
    .description("Score claim recall: the share of required quotes present in context packed at one token budget")
    .argument("<corpus>", "JSONL of {id, text} chunks")
    .argument("<questions>", "JSONL of {id, question, claims: [{id, quote}]}")
    .option("--arms <list>", `comma-separated: ${CLAIM_ARMS.join(" | ")}`, "fts,fts+hash")
    .requiredOption("--budget <tokens>", "token budget every arm packs under")
    .option("--json", "emit rows as JSON instead of a table")
    .action(async (corpusFile, questionsFile, options) => {
      const arms = parseChoices("--arms", String(options.arms), CLAIM_ARMS).map(claimArm);
      const budget = parseBudget(String(options.budget));
      const rows = await claimRecall({
        chunks: parseChunks(readFileSync(corpusFile, "utf8")),
        questions: parseQuestions(readFileSync(questionsFile, "utf8")),
        arms,
        budget,
      });
      console.log(options.json ? JSON.stringify(rows, null, 2) : formatClaimRows(rows));
    });
}

/** `paths` overrides where the --active-root and --graph defaults read env, home and platform from. */
export function buildCli(paths: PathOptions = {}): Command {
  return new Command("retrieval-eval")
    .description("Transcript-mined retrieval eval harness (TP-84)")
    .addCommand(mineCommand(paths))
    .addCommand(freezeCommand(paths))
    .addCommand(runCommand(paths))
    .addCommand(uptakeCommand())
    .addCommand(servedCommand(paths))
    .addCommand(weeklyCommand(paths))
    .addCommand(claimsCommand());
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
