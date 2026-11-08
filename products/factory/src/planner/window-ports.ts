import { openDatabase } from "@titan-design/store-sqlite";
import { z } from "zod";
import type { Verbs } from "../cli-types.js";
import { configPath, loadConfig } from "../config.js";
import { RoundFeedbackSchema } from "../shepherd/round-merge.js";
import { readRounds } from "../shepherd/round-ship-sweep.js";
import { readAllGates } from "../shepherd/owner-friction-read.js";
import { loadSeatBook } from "../shepherd/seats.js";
import type { PlannerRun } from "./inputs.js";
import type { RoundAnswer, WindowGitHub, WindowSources } from "./window-probes.js";

/** One page: a planner window is hours long, and a probe only needs to know whether anything happened. */
const PAGE = "100";

const MergedPrs = z.array(z.object({ number: z.number().int(), mergedAt: z.string() }));
const RedRuns = z.array(z.object({ databaseId: z.number().int(), workflowName: z.string(), createdAt: z.string() }));

async function ghJson<T>(run: PlannerRun, args: readonly string[], schema: z.ZodType<T>): Promise<T> {
  const result = await run("gh", args);
  if (result.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")}: exit ${result.code}: ${result.stderr.trim().split("\n")[0] ?? ""}`);
  return schema.parse(JSON.parse(result.stdout));
}

/** Cancelled is left out: concurrency cancels on main are routine. `gh run list` takes one --status, so each conclusion is its own query. */
const RED_CONCLUSIONS = ["failure", "timed_out", "startup_failure"] as const;

async function redRunsConcluded(run: PlannerRun, repo: string, since: string, conclusion: string) {
  const args = ["run", "list", "--repo", repo, "--branch", "main", "--status", conclusion, "--created", `>=${since}`, "--json", "databaseId,workflowName,createdAt", "--limit", PAGE];
  const runs = await ghJson(run, args, RedRuns);
  return runs.map((r) => ({ id: r.databaseId, workflow: r.workflowName, createdAt: r.createdAt }));
}

export function ghWindow(run: PlannerRun): WindowGitHub {
  return {
    mergedPrs: (repo, since) =>
      ghJson(run, ["pr", "list", "--repo", repo, "--state", "merged", "--search", `merged:>=${since}`, "--json", "number,mergedAt", "--limit", PAGE], MergedPrs),
    redMainRuns: async (repo, since) => {
      const perConclusion = await Promise.all(RED_CONCLUSIONS.map((conclusion) => redRunsConcluded(run, repo, since, conclusion)));
      return perConclusion.flat();
    },
  };
}

/** A round whose feedback does not parse is kept with no date, so the probe reports it rather than losing the owner's answer. */
export async function roundAnswers(roundsDir: string | undefined): Promise<RoundAnswer[]> {
  if (roundsDir === undefined) return [];
  const rounds = await readRounds(roundsDir);
  return rounds.flatMap((round) => (round.feedback === undefined ? [] : [{ id: round.id, submittedAt: submittedAtOf(round.feedback) }]));
}

function submittedAtOf(feedback: Uint8Array): string | undefined {
  try {
    return RoundFeedbackSchema.safeParse(JSON.parse(Buffer.from(feedback).toString("utf8"))).data?.submittedAt;
  } catch {
    return undefined;
  }
}

/** Read-only, so a running serve is never disturbed; a missing store throws, which the wake reads as "run the review". */
function factoryGates(dbPath: string) {
  const db = openDatabase(dbPath, { readonly: true });
  try {
    return readAllGates(db);
  } finally {
    db.close();
  }
}

/** The machine's sources: `gh` for GitHub, the factory store's gates, the console rounds dir, and the seat book's repos unless `repos` names some. */
export function machineWindowSources(verbs: Verbs, run: PlannerRun, repos: readonly string[]): WindowSources {
  const shepherd = loadConfig(configPath(verbs.io.env)).shepherd ?? {};
  const seatRepos = () => [...new Set(loadSeatBook(shepherd).seats.flatMap((seat) => seat.remotes))];
  return {
    github: ghWindow(run),
    repos: repos.length > 0 ? repos : seatRepos(),
    gates: () => factoryGates(verbs.dbPath()),
    rounds: () => roundAnswers(shepherd.consoleAnswers?.roundsDir),
  };
}
