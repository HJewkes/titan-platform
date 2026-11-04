import type { GitHubPort, RepoSlug } from "@titan-design/github";
import { judgeMain, readMainRules, type BaseReader, type MainRules } from "./main-verdict.js";
import { MAIN_WATCH_WINDOW_MS } from "./main-watch.js";

/** How many main commits, the base tip first, are read for a green one containing a red sha before the red stands. */
const STALE_RED_SCAN = 10;

/** True when `tip` is `sha`, or compare reads `sha` as the merge base, so `tip` is ahead of it. */
async function contains(port: GitHubPort, repo: RepoSlug, tip: string, sha: string): Promise<boolean> {
  return tip === sha || (await port.compareFiles(repo, sha, tip)).mergeBaseSha === sha;
}

/** The base tip, then the default branch's commits from the last window newest first, down to `redSha` when it is listed. */
async function candidates(port: GitHubPort, repo: RepoSlug, tip: string, redSha: string, now: number): Promise<string[]> {
  const listed = (await port.listDefaultBranchCommits(repo, new Date(now - MAIN_WATCH_WINDOW_MS).toISOString())).map((commit) => commit.sha);
  const end = listed.indexOf(redSha);
  return [...new Set([tip, ...(end === -1 ? listed : listed.slice(0, end + 1))])].slice(0, STALE_RED_SCAN);
}

interface StaleRedRead {
  port: GitHubPort;
  repo: RepoSlug;
  base: BaseReader | undefined;
}

type MergeRead = StaleRedRead & { mergeSha: string };

/**
 * A commit on the base branch that is or contains `redSha` and is green on every required context, so the red there is
 * stale (TP-4230): main moved past it while the tip itself may still be running. Undefined with no base, no rules or
 * none found, so a red with no green descendant still stands; a read that fails throws and the caller keeps the red.
 */
async function greenContaining(read: StaleRedRead, redSha: string, rules: MainRules | undefined, now: number): Promise<string | undefined> {
  if (read.base === undefined || rules === undefined) return undefined;
  const { port, repo } = read;
  const tip = await port.getHeadSha(repo, await read.base());
  if (tip === null) return undefined;
  for (const sha of await candidates(port, repo, tip, redSha, now)) {
    if (judgeMain(sha, await port.checkRuns(repo, sha), rules).findings.length > 0) continue;
    if ((await contains(port, repo, sha, redSha)) && (await contains(port, repo, tip, sha))) return sha;
  }
  return undefined;
}

/** A red that stood a full wait, read at `red.readSha` or else the merge sha. */
interface StandingRed {
  detail: string;
  readSha?: string;
}

type StaleAck = { verdict: "green"; readSha: string; acknowledgedSha: string; detail: string };

type AwaitingRun = { verdict: "awaiting"; awaitedSha: string };

/**
 * The base tip when it is a later commit containing `redSha` whose required runs are still going with none failed, so a
 * fix that merged after the red may yet clear it (TP-4273). A required context with no run yet counts as running, as
 * after a push whose runs are queued but not yet reported (TP-4653). Undefined with no base or rules, a settled or red tip, or a
 * tip off the red's line; a read that fails throws and the caller keeps the red.
 */
async function runningDescendant(read: StaleRedRead, redSha: string, rules: MainRules | undefined): Promise<string | undefined> {
  if (read.base === undefined || rules === undefined) return undefined;
  const tip = await read.port.getHeadSha(read.repo, await read.base());
  if (tip === null || tip === redSha) return undefined;
  const { findings } = judgeMain(tip, await read.port.checkRuns(read.repo, tip), rules);
  if (!findings.some((finding) => finding.kind === "pending" || finding.kind === "missing") || findings.some((finding) => finding.kind === "failed")) return undefined;
  return (await contains(read.port, read.repo, tip, redSha)) ? tip : undefined;
}

/**
 * The red, unless a green main commit is or contains the sha it was read at, or the base tip contains it and is still
 * running, which the red then awaits; a failed read keeps the red.
 */
async function unlessStale<R extends StandingRed>(read: MergeRead, red: R, rules: MainRules | undefined, now: number): Promise<R | StaleAck | AwaitingRun> {
  const redSha = red.readSha ?? read.mergeSha;
  const green = await greenContaining(read, redSha, rules, now).catch(() => undefined);
  if (green !== undefined) return { readSha: green, acknowledgedSha: green, verdict: "green", detail: `${red.detail}; stale: main commit ${green} contains it and is green on every required context` };
  const running = await runningDescendant(read, redSha, rules).catch(() => undefined);
  return running === undefined ? red : { verdict: "awaiting", awaitedSha: running };
}

/**
 * A red past its wait: as unlessStale reads it, except that a red already awaiting a running tip re-reads only that tip
 * each poll, and reads the green line again once the tip stops running.
 */
export async function heldRed<R extends StandingRed>(read: MergeRead, red: R, awaiting: string | undefined, rules: MainRules | undefined, now: number): Promise<R | StaleAck | AwaitingRun> {
  const tip = awaiting === undefined ? undefined : await runningDescendant(read, red.readSha ?? read.mergeSha, rules).catch(() => undefined);
  return tip === undefined ? unlessStale(read, red, rules, now) : { verdict: "awaiting", awaitedSha: tip };
}

/**
 * Reads the base branch's required contexts and app pins once they are readable, then answers the base tip when it is or
 * contains the merge sha and judgeMain finds nothing on it. No PR, unreadable or empty rules, or a tip that does not
 * contain the merge answers undefined, so nothing is acknowledged on a guess.
 */
export function greenContainingReader(main: MergeRead): () => Promise<string | undefined> {
  let rules: { base: string; rules: MainRules } | undefined;
  return async () => {
    if (main.base === undefined) return undefined;
    rules ??= await baseMainRules(main.port, main.repo, await main.base());
    if (rules === undefined) return undefined;
    const tip = await main.port.getHeadSha(main.repo, rules.base);
    if (tip === null || !(await contains(main.port, main.repo, tip, main.mergeSha))) return undefined;
    return judgeMain(tip, await main.port.checkRuns(main.repo, tip), rules.rules).findings.length === 0 ? tip : undefined;
  };
}

async function baseMainRules(port: GitHubPort, repo: RepoSlug, baseRef: string): Promise<{ base: string; rules: MainRules } | undefined> {
  const { rules } = await readMainRules(port, repo, baseRef);
  return rules === undefined ? undefined : { base: baseRef, rules };
}
