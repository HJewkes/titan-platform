import { execFile } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { treeDigest } from "../review-pr/build-cases.js";
import { archiveInto, verifyCommit, type BundleGit } from "../review-pr/bundle.js";

const run = promisify(execFile);

interface CaseCommits {
  base: string;
  merge: string;
}

interface BaseTree {
  path: string;
  treeSha256: string;
}

/** A fixed identity and date, so one tree always seeds the same commit sha whoever runs the export. */
const SEED_ENV = {
  GIT_AUTHOR_NAME: "titan-evals",
  GIT_AUTHOR_EMAIL: "titan-evals@example.invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "titan-evals",
  GIT_COMMITTER_EMAIL: "titan-evals@example.invalid",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};
const SEED_CONFIG = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

async function gitIn(dir: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", dir, ...SEED_CONFIG, ...args], { env: { ...process.env, ...SEED_ENV }, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Archives the merge's first parent into `<outDir>/trees/<id>`. The base must be that parent: any other commit could
 * already hold part of the answer, or miss what main had when the task was briefed.
 */
export async function writeBaseTree(port: BundleGit, commits: CaseCommits, outDir: string, id: string): Promise<BaseTree> {
  await verifyCommit(port, commits.merge);
  await verifyCommit(port, commits.base);
  const parent = (await port.git(["rev-parse", `${commits.merge}^1`])).toString("utf8").trim();
  if (parent !== commits.base) throw new Error(`base ${commits.base} is not the first parent of merge ${commits.merge} (${parent})`);
  const path = `trees/${id}`;
  mkdirSync(join(outDir, "trees"), { recursive: true });
  await archiveInto(port, commits.base, join(outDir, path));
  return { path, treeSha256: treeDigest(join(outDir, path)) };
}

/** Copies a base tree into a fresh repo with one root commit, so the trial sees no later history to read the answer from. */
export async function seedWorkspace(treeDir: string, workspaceDir: string): Promise<string> {
  cpSync(treeDir, workspaceDir, { recursive: true, errorOnExist: true, force: false });
  await gitIn(workspaceDir, ["init", "-q", "-b", "main"]);
  await gitIn(workspaceDir, ["add", "-A"]);
  await gitIn(workspaceDir, ["commit", "-q", "--allow-empty", "-m", "base"]);
  return gitIn(workspaceDir, ["rev-parse", "HEAD"]);
}

/** Refuses a workspace with more than its one seeded commit, or one that can still reach the accepted merge. */
export async function assertNoLaterHistory(workspaceDir: string, mergeSha: string): Promise<void> {
  const count = Number(await gitIn(workspaceDir, ["rev-list", "--all", "--count"]));
  if (count !== 1) throw new Error(`workspace ${workspaceDir} holds ${count} commits; a seeded workspace holds exactly one`);
  const reachable = await gitIn(workspaceDir, ["cat-file", "-e", `${mergeSha}^{commit}`]).then(
    () => true,
    () => false,
  );
  if (reachable) throw new Error(`workspace ${workspaceDir} holds the accepted merge ${mergeSha}`);
}
