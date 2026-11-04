import { runGit } from "@titan-design/worktree";
import { execSafeAsync, minimalEnv } from "../exec.js";

/**
 * CC-1064: a squash merge leaves the PR's commits nowhere on origin once the head branch is deleted, so
 * park asks GitHub which merged PRs had that head branch and checks HEAD against each PR's head commit.
 */

const READ_TIMEOUT_MS = 15_000;

export interface MergedPr {
  number: number;
  headSha: string;
}

/** Merged PRs whose head was `branch`; rejects when it cannot tell, which park treats as a refusal. */
export type MergedPrReader = (gitRoot: string, branch: string) => Promise<MergedPr[]>;

export interface MergedPrGhOutcome {
  exitCode: number;
  stdout: string;
}

/** Runs `gh` in `cwd`. A host whose `gh` needs more than `minimalEnv` (a token, a shim, a PATH entry) passes its own. */
export type MergedPrGh = (args: readonly string[], cwd: string) => Promise<MergedPrGhOutcome>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function parseMergedPr(pr: unknown): MergedPr {
  const { number, headRefOid } = isRecord(pr) ? pr : {};
  if (typeof number !== "number" || typeof headRefOid !== "string")
    throw new Error("gh pr list answered a PR without number and headRefOid");
  return { number, headSha: headRefOid };
}

export function parseMergedPrs(stdout: string): MergedPr[] {
  const prs: unknown = JSON.parse(stdout);
  if (!Array.isArray(prs)) throw new Error("gh pr list did not answer a JSON array");
  return prs.map(parseMergedPr);
}

const runGh: MergedPrGh = async (args, cwd) => {
  const { status, stdout } = await execSafeAsync("gh", [...args], minimalEnv(), READ_TIMEOUT_MS, undefined, cwd);
  return { exitCode: status, stdout };
};

/** A repo with no origin has nowhere to hold a PR; otherwise `gh` answers, and its failure rejects. */
export const mergedPrReader =
  (gh: MergedPrGh): MergedPrReader =>
  async (gitRoot, branch) => {
    if ((await runGit(["remote", "get-url", "origin"], gitRoot)) === null) return [];
    const fields = "number,headRefOid,mergedAt";
    const args = ["pr", "list", "--head", branch, "--state", "merged", "--json", fields, "--limit", "5"];
    const { exitCode, stdout } = await gh(args, gitRoot);
    if (exitCode !== 0) throw new Error(`gh pr list exited ${exitCode}`);
    return parseMergedPrs(stdout);
  };

export const readMergedPrs: MergedPrReader = mergedPrReader(runGh);
