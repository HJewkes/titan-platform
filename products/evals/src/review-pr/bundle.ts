import { execFile, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const MAX_BUFFER = 1024 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;

/** Runs `git` against one local clone; it is never handed `gh`, a remote or a fetch, so a bundle cannot reach the network. */
export interface BundleGit {
  git(args: readonly string[]): Promise<Buffer>;
}

export interface BundleCommits {
  head: string;
  base: string;
}

export interface Bundle {
  head: string;
  base: string;
  diff: string;
}

export function localCloneGit(cloneDir: string): BundleGit {
  return {
    git: async (args) => (await run("git", ["-C", cloneDir, ...args], { encoding: "buffer", maxBuffer: MAX_BUFFER })).stdout,
  };
}

function extractTar(tar: Buffer, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-x", "-f", "-", "-C", dir], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => void (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${stderr.trim()}`))));
    child.stdin.end(tar);
  });
}

/** `git archive` writes the tree alone, so no `.git` lands in the bundle and `git log --all` cannot reach a later fix. */
async function archiveInto(port: BundleGit, sha: string, dir: string): Promise<void> {
  mkdirSync(dir);
  await extractTar(await port.git(["archive", "--format=tar", sha]), dir);
}

/** Only full shas the clone already holds: a ref name could move, and a missing commit is never fetched. */
async function verifyCommit(port: BundleGit, sha: string): Promise<void> {
  if (!SHA.test(sha)) throw new Error(`bundle commits must be 40-hex shas, got ${JSON.stringify(sha)}`);
  await port.git(["cat-file", "-e", `${sha}^{commit}`]);
}

/** Writes `<dir>/head`, `<dir>/base` and `<dir>/diff.patch` from a local clone; `dir` must not already hold a bundle. */
export async function materializeBundle(port: BundleGit, commits: BundleCommits, dir: string): Promise<Bundle> {
  await verifyCommit(port, commits.head);
  await verifyCommit(port, commits.base);
  const bundle = { head: join(dir, "head"), base: join(dir, "base"), diff: join(dir, "diff.patch") };
  mkdirSync(dir, { recursive: true });
  await archiveInto(port, commits.head, bundle.head);
  await archiveInto(port, commits.base, bundle.base);
  writeFileSync(bundle.diff, await port.git(["diff", "--no-color", "--no-ext-diff", commits.base, commits.head]));
  return bundle;
}
