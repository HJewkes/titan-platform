import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { activeWorkGraphPath, activeWorkRoot } from "@titan-design/app-paths";
import { Command, CommanderError } from "commander";
import { z } from "zod";
import { defaultPolicy } from "../private/exclusion.js";
import { writeHistory } from "./build.js";
import { loadWindow } from "./gh-cache.js";
import { openGraph } from "./graph.js";
import { ensureMirror } from "./mirror.js";
import { v2Parity, type StoredCase } from "./parity.js";

interface BuildFlags {
  until: string;
  out: string;
  owner: string;
  repo?: string[];
  graph?: string;
  mirrors: string;
  activeWorkRoot?: string;
  fetch: boolean;
}

type ParityFlags = Record<"ghCache" | "cases" | "asOf" | "owner", string>;

const collect = (value: string, all: string[] = []): string[] => [...all, value];

async function runBuild(flags: BuildFlags): Promise<void> {
  const graphPath = flags.graph ?? activeWorkGraphPath();
  // Only private/exclusion.ts owns the allowlist: --repo narrows what is built, never what is allowed.
  const policy = defaultPolicy(flags.activeWorkRoot ?? activeWorkRoot());
  const repos = flags.repo ?? policy.repos.map((name) => `${flags.owner}/${name}`);
  const graph = openGraph(graphPath);
  try {
    const mirrorFor = (repo: string) => ensureMirror(flags.mirrors, repo, { fetch: flags.fetch });
    const summary = await writeHistory(flags.out, { graph, mirrorFor, repos, until: flags.until, policy });
    console.error(JSON.stringify({ graph: graphPath, summary }));
  } finally {
    graph.close();
  }
}

const StoredCaseRow = z.looseObject({ case_id: z.string(), repo: z.string(), pr_number: z.number() });

function readStoredCases(path: string): StoredCase[] {
  const rows = readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "");
  return rows.map((line) => StoredCaseRow.parse(JSON.parse(line)));
}

function runParity(flags: ParityFlags): boolean {
  const stored = readStoredCases(flags.cases);
  const repos = [...new Set(stored.map((entry) => entry.repo))].sort();
  const windows = Object.fromEntries(repos.map((repo) => [repo, loadWindow(flags.ghCache, { owner: flags.owner, repo, asOf: flags.asOf })]));
  const report = v2Parity(windows, stored);
  console.log(JSON.stringify({ cases: report.cases, mismatches: report.mismatches.length, missing: report.missing.length }));
  for (const mismatch of report.mismatches) console.log(`mismatch ${mismatch.case_id} ${mismatch.field}`);
  return report.mismatches.length === 0;
}

function reporting<F>(name: string, onResult: (code: number) => void, run: (flags: F) => boolean | Promise<boolean | void>) {
  return async (flags: F): Promise<void> => {
    try {
      onResult((await run(flags)) === false ? 1 : 0);
    } catch (error) {
      if (error instanceof CommanderError) throw error;
      console.error(`history ${name}: ${error instanceof Error ? error.message : String(error)}`);
      onResult(1);
    }
  };
}

function buildCommand(onResult: (code: number) => void): Command {
  return new Command("build")
    .description("Write cases.jsonl and summary.json: merged PRs from the session graph with git facts from bare mirrors. Calls no GitHub API")
    .requiredOption("--until <iso>", "list PRs merged at or before this instant")
    .requiredOption("--out <dir>", "an empty dir outside every git work tree")
    .option("--owner <owner>", "the owner of the default repos", "HJewkes")
    .option("--repo <owner/repo>", "a repo to build; repeatable (default: the exclusion's engineering repos); others are excluded as private", collect)
    .option("--graph <path>", "the session graph, opened with mode=ro (default: the active-work graph)")
    .option("--mirrors <dir>", "where the bare mirrors live", join(homedir(), ".cache", "titan-corpus", "mirrors"))
    .option("--active-work-root <dir>", "the active-work root the private markers are read from")
    .option("--no-fetch", "use the mirrors as they are; a missing mirror is an error")
    .exitOverride()
    .action(reporting("build", onResult, runBuild));
}

function parityCommand(onResult: (code: number) => void): Command {
  return new Command("v2-parity")
    .description("Recompute label v2 from a gh-cache window and compare it with stored cases; exits 1 on any mismatch")
    .requiredOption("--gh-cache <dir>", "the cached REST JSON the v2 build wrote; never fetched")
    .requiredOption("--cases <jsonl>", "the stored v2 cases")
    .requiredOption("--as-of <iso>", "the instant the v2 window was pinned at")
    .option("--owner <owner>", "the owner of every case repo", "HJewkes")
    .exitOverride()
    .action(reporting("v2-parity", onResult, runParity));
}

export function historyCommand(onResult: (code: number) => void): Command {
  return new Command("history")
    .description("The eval corpus history build, from the session graph and local mirrors")
    .addCommand(buildCommand(onResult))
    .addCommand(parityCommand(onResult))
    .exitOverride();
}
