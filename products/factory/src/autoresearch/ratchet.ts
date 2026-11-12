import { execFile } from "node:child_process";
import { promisify } from "node:util";

type Git = (args: readonly string[], cwd: string) => Promise<string>;

const run = promisify(execFile);

export const execGit: Git = async (args, cwd) => (await run("git", [...args], { cwd })).stdout.trim();

/** Slash-separated segments, so an empty, doubled, leading or trailing slash cannot widen the prefix to `refs/heads/`. */
export const PREFIX = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/**
 * The ratchet writes only a run's own branch under the target's prefix. Each refusal has its own code, so a test can
 * tell the main and default-branch guards apart from the prefix guard that would also refuse them.
 */
function assertRatchetRef(ref: string, prefix: string, defaultBranch: string): void {
  if (!PREFIX.test(prefix)) throw new Error(`[ratchet-prefix] "${prefix}" is not a ratchet prefix`);
  if (ref === "refs/heads/main") throw new Error(`[ratchet-main] ${ref} is never a ratchet`);
  if (ref === `refs/heads/${defaultBranch}`) throw new Error(`[ratchet-default] ${ref} is the default branch`);
  const under = `refs/heads/${prefix}/`;
  if (!ref.startsWith(under) || ref.length === under.length) throw new Error(`[ratchet-ref] ${ref} is not a branch under ${under}`);
}

/** The branch `origin`'s HEAD names; a ratchet that cannot read it fails closed rather than guess. */
export async function remoteDefaultBranch(git: Git, tree: string): Promise<string> {
  const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(await git(["ls-remote", "--symref", "origin", "HEAD"], tree))?.[1];
  if (branch === undefined) throw new Error(`[ratchet-default] unknown: origin HEAD in ${tree} names no branch`);
  return branch;
}

const remoteHead = async (git: Git, tree: string, ref: string) => (await git(["ls-remote", "origin", ref], tree)).split(/\s/)[0] ?? "";

interface RatchetTarget {
  /** The integration tree: a checkout of the target repo whose `origin` holds the ratchet branch. */
  tree: string;
  ratchetRef: string;
  ratchetPrefix: string;
  /** The branch `origin`'s HEAD names, read once per session. */
  defaultBranch: string;
}

interface RatchetMove extends RatchetTarget {
  /** The ratchet head this winner was judged against. */
  from: string;
  /** The winner's commit. */
  to: string;
}

/** The only code that moves the ratchet: fast-forward only, and only from the head the keep rule was run against. */
export async function ratchetFastForward(git: Git, move: RatchetMove): Promise<{ head: string }> {
  assertRatchetRef(move.ratchetRef, move.ratchetPrefix, move.defaultBranch);
  const remote = await remoteHead(git, move.tree, move.ratchetRef);
  if (remote !== move.from) throw new Error(`[ratchet-moved] ${move.ratchetRef} is at ${remote || "nothing"}, not ${move.from}`);
  await git(["checkout", "--quiet", "--detach", move.from], move.tree);
  await git(["merge", "--ff-only", "--quiet", move.to], move.tree);
  await git(["push", "--quiet", `--force-with-lease=${move.ratchetRef}:${move.from}`, "origin", `HEAD:${move.ratchetRef}`], move.tree);
  return { head: await git(["rev-parse", "HEAD"], move.tree) };
}

/**
 * Creates the run's ratchet at the pin. The empty lease means the push only creates. git treats a ref already at the
 * pin as up to date, so a restarted pin succeeds; a ref anywhere else belongs to something this run must not overwrite.
 */
export async function seedRatchet(git: Git, seed: RatchetTarget & { pin: string }): Promise<void> {
  assertRatchetRef(seed.ratchetRef, seed.ratchetPrefix, seed.defaultBranch);
  const pushing = git(["push", "--quiet", `--force-with-lease=${seed.ratchetRef}:`, "origin", `${seed.pin}:${seed.ratchetRef}`], seed.tree);
  const failure = await pushing.then(() => undefined, (error: unknown) => error);
  if (failure === undefined) return;
  const remote = await remoteHead(git, seed.tree, seed.ratchetRef);
  // A push that failed with no ref in the way failed for another reason, which a retry may clear.
  if (remote === "") throw failure;
  throw new Error(`[ratchet-exists] ${seed.ratchetRef} is at ${remote}, not the pin ${seed.pin}`);
}
